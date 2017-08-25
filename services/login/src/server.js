import express from 'express';
import passport from 'passport';
import _ from 'lodash';
import sslify from 'express-sslify';
import http from 'http';
import path from 'path';
import session from 'cookie-session';
import config from 'taskcluster-lib-config';
import bodyParser from 'body-parser';
import User from './user';
import querystring from 'querystring';
import loader from 'taskcluster-lib-loader';
import taskcluster from 'taskcluster-client';
import flash from 'connect-flash';
import scanner from './scanner';
import Authorizer from './authz';
import v1 from './v1';
import LDAPClient from './ldap';
import tcApp from 'taskcluster-lib-app';
import validator from 'taskcluster-lib-validate';
import monitor from 'taskcluster-lib-monitor';
import docs from 'taskcluster-lib-docs';

require('source-map-support').install();

let load = loader({
  cfg: {
    requires: ['profile'],
    setup: ({profile}) => {
      return config({profile});
    },
  },

  authorizer: {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let authorizer = new Authorizer(cfg);
      await authorizer.setup();
      return authorizer;
    },
  },

  authenticators: {
    requires: ['cfg', 'authorizer'],
    setup: ({cfg, authorizer}) => {
      let authenticators = {};

      // carry out the authorization process, either with a done callback
      // or returning a promise
      let authorize = (user, done) => {
        let promise = authorizer.authorize(user);
        if (done) {
          promise.then(() => done(null, user), (err) => done(err, null));
        } else {
          return promise;
        }
      };

      cfg.app.authenticators.forEach((name) => {
        let Authn = require('./authn/' + name);
        authenticators[name] = new Authn({cfg, authorize});
      });
      return authenticators;
    },
  },

  handlers: {
    requires: ['cfg'],
    setup: ({cfg}) => {
      let handlers = {};

      // carry out the authorization process, either with a done callback
      // or returning a promise
      let authorize = (user, done) => {
        let promise = authorizer.authorize(user);
        if (done) {
          promise.then(() => done(null, user), (err) => done(err, null));
        } else {
          return promise;
        }
      };

      Object.keys(cfg.handlers).forEach((name) => {
        let Handler = require('./handlers/' + name).default;
        handlers[name] = new Handler({name, cfg});
      });
      return handlers;
    },
  },

  monitor: {
    requires: ['process', 'profile', 'cfg'],
    setup: ({process, profile, cfg}) => monitor({
      project: 'taskcluster-login',
      credentials: cfg.app.credentials,
      mock: profile !== 'production',
      process,
    }),
  },

  validator: {
    requires: ['cfg'],
    setup: ({cfg}) => {
      return validator({
        prefix: 'login/v1/',
        publish: cfg.app.publishMetaData,
        aws: cfg.aws,
      });
    },
  },

  router: {
    requires: ['cfg', 'validator', 'monitor', 'handlers'],
    setup: ({cfg, validator, monitor, handlers}) => {
      return v1.setup({
        context: {},
        validator,
        authBaseUrl:      cfg.authBaseUrl,
        publish:          cfg.app.publishMetaData,
        baseUrl:          cfg.server.publicUrl + '/v1',
        referencePrefix:  'login/v1/api.json',
        aws:              cfg.aws,
        monitor:          monitor.prefix('api'),
        context:          {cfg, handlers},
      });
    },
  },

  docs: {
    requires: ['cfg', 'validator'],
    setup: ({cfg, validator}) => docs.documenter({
      credentials: cfg.app.credentials,
      tier: 'integrations',
      schemas: validator.schemas,
      references: [
        {
          name: 'api',
          reference: v1.reference({baseUrl: cfg.server.publicUrl + '/v1'}),
        },
      ],
    }),
  },

  app: {
    requires: ['cfg', 'authenticators', 'router'],
    setup: ({cfg, authenticators, router}) => {
      // Create application
      let app = tcApp(cfg.server);

      // setup 'trust proxy', which tc-lib-app does not do
      app.set('trust proxy', cfg.server.trustProxy);

      // Setup API
      app.use('/v1', router);

      // Setup views and assets
      app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));
      app.set('views', path.join(__dirname, '..', 'views'));
      app.set('view engine', 'jade');

      // Parse request bodies
      app.use(bodyParser.urlencoded({extended: false}));

      // Store session in a signed cookie
      app.use(session({
        name: 'taskcluster-login',
        keys: cfg.app.cookieSecrets,
        secure: cfg.server.forceSSL,
        secureProxy: cfg.server.trustProxy,
        httpOnly: true,
        signed: true,
        maxAge: 5 * 60 * 1000,
      }));

      // Set up message flashing
      app.use(flash());

      // Initialize passport
      app.use(passport.initialize());
      app.use(passport.session());

      // Read and write user from signed cookie
      passport.serializeUser((user, done) => done(null, user.serialize()));
      passport.deserializeUser((data, done) => done(null, User.deserialize(data)));

      // set up authenticators' sub-paths
      _.forIn(authenticators, (authn, name) => {
        app.use('/' + name, authn.router());
      });

      // Add logout method
      app.post('/logout', (req, res) => {
        req.logout();
        res.redirect('/');
      });

      // Render index
      app.get('/', (req, res) => {
        let user = User.get(req);
        let {credentials} = user.createCredentials(cfg.app.temporaryCredentials);
        res.render('index', {
          user, credentials,
          querystring,
          allowedHosts: cfg.app.allowedRedirectHosts,
          query: req.query,
          flash: req.flash(),
          session: req.session,
          auth0_domain: cfg.auth0.domain,
          auth0_client_id: cfg.auth0.clientId,
        });
      });

      return app;
    },
  },

  server: {
    requires: ['cfg', 'app', 'docs'],
    setup: async ({cfg, app, docs}) => {
      // Create server and start listening
      return app.createServer();
    },
  },

  scanner: {
    requires: ['cfg', 'authorizer'],
    setup: async ({cfg, authorizer}) => {
      await scanner(cfg, authorizer);
      // the LDAP connection is still open, so we must exit
      // explicitly or node will wait forever for it to die.
      process.exit(0);
    },
  },

  // utility function to show LDAP groups for a user
  'show-ldap-user': {
    requires: ['cfg'],
    setup: async ({cfg}) => {
      let email = process.argv[3];
      if (!email) {
        console.error('Specify an email address on the command line');
        process.exit(1);
        return;
      }

      let client = new LDAPClient(cfg.ldap);
      client.bind(cfg.ldap.user, cfg.ldap.password);

      let userDn = await client.dnForEmail(email);

      if (!userDn) {
        console.error(`no user found for ${email}; skipping LDAP groups`);
        process.exit(1);
        return;
      }

      let entries = await client.search(
        'dc=mozilla', {
          scope: 'sub',
          filter: '(&(objectClass=groupOfNames)(member=' + userDn + '))',
          attributes: ['cn'],
          timeLimit: 10,
        });
      let groups = entries.map(entry => entry.object.cn);

      // SCM groups are posixGroup objects with the email in the memberUid
      // field.  This code does not capture other POSIX groups (which have the
      // user's uid field in the memberUid field).
      entries = await client.search(
        'dc=mozilla', {
          scope: 'sub',
          filter: '(&(objectClass=posixGroup)(memberUid=' + email + '))',
          attributes: ['cn'],
          timeLimit: 10,
        });
      groups = groups.concat(entries.map(entry => entry.object.cn));

      groups.sort();
      groups.forEach(gp => console.log(gp));

      process.exit(0);
    },
  },
}, ['profile', 'process']);

if (!module.parent) {
  load(process.argv[2], {
    profile: process.env.NODE_ENV,
    process: process.argv[2],
  }).catch(err => {
    console.log('Server crashed: ' + err.stack);
    process.exit(1);
  });
}

module.exports = load;
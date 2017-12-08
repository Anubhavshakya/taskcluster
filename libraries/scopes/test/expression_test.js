import assert from 'assert';
import utils from '../lib/expressions.js';

suite('scope expression validity:', function() {

  function scenario(expr, shouldFail=false) {
    return () => {
      try {
        assert(utils.validExpression(expr));
      } catch (err) {
        if (shouldFail) {
          return;
        }
        throw err;
      }
      if (shouldFail) {
        throw new Error('Should have failed!');
      }
    };
  }

  // All of the following are invalid
  test('empty is not OK', scenario({}, 'should-fail'));
  test('array is not OK', scenario([], 'should-fail'));
  test('int is not OK', scenario(12, 'should-fail'));
  test('string is not OK', scenario('scope:foo', 'should-fail'));
  test('wrong key is not OK', scenario({Foo: ['abc']}, 'should-fail'));
  test('multiple keys is not OK', scenario({AnyOf: ['abc'], AllOf: ['abc']}, 'should-fail'));
  test('int value is not OK', scenario({AnyOf: 1}, 'should-fail'));
  test('string value is not OK', scenario({AnyOf: 'scope:bar'}, 'should-fail'));
  test('object value is not OK', scenario({AnyOf: {}}, 'should-fail'));
  test('empty subexpression is not OK', scenario({AnyOf: []}, 'should-fail'));

  // All of the following should be valid
  [
    {AnyOf: ['abc']},
    {AllOf: ['abc']},
    {AnyOf: [{AnyOf: ['scope:foo:thing']}]},
    {AllOf: [{AllOf: ['scope:foo:thing', 'scope:bar:thing']}]},
    {AnyOf: [{AllOf: ['scope:foo:thing']}]},
    {AllOf: [{AnyOf: ['scope:foo:thing', 'scope:bar:thing']}]},
    {AllOf: [{AnyOf: [{AllOf: ['foo']}, {AllOf: ['bar']}]}]},
  ].map(c => {
    test(`${JSON.stringify(c)} is OK`, scenario(c));
  });
});

suite('scope expression satisfaction:', function() {

  function scenario(scopes, expr, shouldFail=false) {
    return () => {
      try {
        assert(utils.satisfiesExpression(scopes, expr));
      } catch (err) {
        if (shouldFail) {
          return;
        }
        throw err;
      }
      if (shouldFail) {
        throw new Error('Should have failed!');
      }
    };
  }

  // The following should _not_ succeed
  [
    [['ghi'], {AnyOf: ['abc', 'def']}],
    [['ghi*'], {AnyOf: ['abc', 'def']}],
    [['ghi', 'fff'], {AnyOf: ['abc', 'def']}],
    [['ghi*', 'fff*'], {AnyOf: ['abc', 'def']}],
    [['abc'], {AnyOf: ['ghi']}],
    [['abc*'], {AllOf: ['abc', 'ghi']}],
    [[''], {AnyOf: ['abc', 'def']}],
    [['abc:def'], {AnyOf: ['abc', 'def']}],
  ].map(([s, e]) => {
    test(`${JSON.stringify(e)} is _not_ satisfied by ${JSON.stringify(s)}`, scenario(s, e, 'should-fail'));
  });

  // The following should succeed
  [
    [['abc'], {AnyOf: ['abc', 'def']}],
    [['def'], {AnyOf: ['abc', 'def']}],
    [['abc', 'def'], {AnyOf: ['abc', 'def']}],
    [['abc*'], {AnyOf: ['abc', 'def']}],
    [['abc*'], {AnyOf: ['abc']}],
    [['abc*', 'def*'], {AnyOf: ['abc', 'def']}],
  ].map(([s, e]) => {
    test(`${JSON.stringify(e)} is satisfied by ${JSON.stringify(s)}`, scenario(s, e));
  });

});
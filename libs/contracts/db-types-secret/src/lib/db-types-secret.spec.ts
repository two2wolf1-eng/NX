import { dbTypesSecret } from './db-types-secret.js';

describe('dbTypesSecret', () => {
  it('should work', () => {
    expect(dbTypesSecret()).toEqual('db-types-secret');
  });
});

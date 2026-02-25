import { secret } from './secret.js';

describe('secret', () => {
  it('should work', () => {
    expect(secret()).toEqual('secret');
  });
});

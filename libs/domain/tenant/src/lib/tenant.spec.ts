import { tenant } from './tenant.js';

describe('tenant', () => {
  it('should work', () => {
    expect(tenant()).toEqual('tenant');
  });
});

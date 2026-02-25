import { supabaseSecret } from './supabase-secret.js';

describe('supabaseSecret', () => {
  it('should work', () => {
    expect(supabaseSecret()).toEqual('supabase-secret');
  });
});

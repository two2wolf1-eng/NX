import { supabaseSecret } from '__SECRET_PACKAGE__';

export function shouldFailBoundaryCheck() {
  return supabaseSecret;
}

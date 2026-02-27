import { supabaseSecret } from '__SECRET_PACKAGE__';

export function shouldPassBoundaryCheck() {
  return supabaseSecret();
}

import { tenant } from '__DOMAIN_PACKAGE__';
import { supabaseBiz } from '__DATA_ACCESS_PACKAGE__';

export function shouldFailContractBoundaryCheck() {
  return [tenant, supabaseBiz];
}

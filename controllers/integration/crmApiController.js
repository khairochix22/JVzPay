// GET /api/v1/crm/* — read API for the CRM system. CRM service token only. docs/API_INTEGRATION.md §5.3
import { jsonApi } from "../../middleware/apiClient.js";
import * as q from "../../services/integrationQueryService.js";

export const sale = jsonApi((req) => q.crmSale(req.params.transactionId));
export const receivables = jsonApi((req) => q.crmReceivables(req.query));
export const customerBalance = jsonApi((req) => q.crmCustomerBalance(req.params.customerRef));

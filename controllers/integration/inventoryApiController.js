// GET /api/v1/inventory/* — read API for the Inventory system. Inventory service token only. docs/API_INTEGRATION.md §5.4
import { jsonApi } from "../../middleware/apiClient.js";
import * as q from "../../services/integrationQueryService.js";

export const purchaseOrder = jsonApi((req) => q.inventoryPurchaseOrder(req.params.purchaseOrderId));
export const supplierInvoices = jsonApi((req) => q.inventorySupplierInvoices(req.query));
export const supplierBalance = jsonApi((req) => q.inventorySupplierBalance(req.params.supplierRef));

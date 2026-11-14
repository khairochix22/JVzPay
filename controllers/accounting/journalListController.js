// Journal Entries list page (GET /accounting/journals).
import { wrap } from "../../lib/errors.js";
import { listJournals } from "../../services/accountingService.js";

export const list = wrap(async (req, res) => {
  res.render("journals", { title: "Journal Entries", ...(await listJournals(req)) });
});

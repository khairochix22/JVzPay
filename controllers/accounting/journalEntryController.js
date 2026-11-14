// Journal entry page (GET /accounting/journals/:id): lines, totals and its link to the originating or reversing entry.
import { wrap } from "../../lib/errors.js";
import { getJournal } from "../../services/accountingService.js";

export const show = wrap(async (req, res) => {
  const j = await getJournal(Number(req.params.id));
  res.render("journal-entry", { title: `Journal ${j.entry_no}`, j });
});

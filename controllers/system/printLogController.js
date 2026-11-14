// POST /activity/print: the browser reports that a page is being printed, so printing is in the audit trail like exporting.
import { logPrint } from "../../services/securityService.js";

export const logPrinted = async (req, res, next) => {
  try {
    await logPrint(req);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
};

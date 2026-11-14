// Supporting documents. URL map only; handler lives in controllers/documents.
import express from "express";
import * as documentController from "../controllers/documents/documentController.js";

const r = express.Router();


r.get("/:id(\\d+)", documentController.download);

export default r;

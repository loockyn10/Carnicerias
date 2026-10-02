import {
  applyImportBatchAction,
  cancelImportBatchAction,
  createImportBatchAction,
  listImportRowsAction,
  listImportSuppliersAction,
  previewImportBatchAction,
  stageImportRowsAction,
  type ImportActionResult
} from "../../app/admin/imports/actions";
import type { ImportGateway } from "./runner";

function unwrap<T>(result: ImportActionResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** The import gateway used by the Admin screen: every call is a Server Action (Admin-only, RLS-bound). */
export const serverImportGateway: ImportGateway = {
  async createBatch(input) {
    return unwrap(await createImportBatchAction(input));
  },
  async stageRows(batchId, rows) {
    unwrap(await stageImportRowsAction(batchId, rows));
  },
  async previewBatch(batchId) {
    return unwrap(await previewImportBatchAction(batchId));
  },
  async listRows(batchId) {
    return unwrap(await listImportRowsAction(batchId));
  },
  async listSuppliers(batchId) {
    return unwrap(await listImportSuppliersAction(batchId));
  },
  async applyBatch(batchId, skipErrors) {
    return unwrap(await applyImportBatchAction(batchId, skipErrors));
  },
  async cancelBatch(batchId) {
    unwrap(await cancelImportBatchAction(batchId));
  }
};

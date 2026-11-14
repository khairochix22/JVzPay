// Link to the HR system's employee records.
// PENDING: the HR system is still being built and its database is not connected, so every check answers
// "not_connected" and account requests wait for an Accounting Supervisor. When HR is ready, implement verifyEmployee()
// against the HR database: return { status: "verified" } when the name, employee ID, position and unique code
// all match an active employee, otherwise { status: "not_found" }.
export const HR_CONNECTED = false;

export async function verifyEmployee() {
  return { status: "not_connected" };
}

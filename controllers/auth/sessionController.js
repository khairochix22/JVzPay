// POST /session/keepalive: "Stay signed in" on the inactivity warning. Any signed-in request already extends the session;
// this one does nothing else, so the page can extend it without reloading.
export const keepAlive = (req, res) => res.status(204).end();

# LiftOps Elevator Management PWA — Database / Multi-user Edition

LiftOps is now a **server-backed multi-user PWA**. Elevator, workflow, maintenance, user and activity data are shared through one SQLite database instead of being stored in each browser's `localStorage`.

## What changed in v10

### Automatic Generated Services
Automatic Generated Services inside **Maintenance & Service** are no longer assigned to technicians.

- No Accept / Assign button is shown.
- Generated inspection-support and preventive-maintenance work remains in the shared generated-services list.
- A normal Service Record can be created when work is actually planned/performed.
- Older pending records that were created only by the previous generated-job assignment workflow are returned to the generated queue when the v10 database migration runs.

### Multi-user operation
Multiple users can open the same LiftOps server at the same time.

- All clients read/write one shared database.
- The browser refreshes shared data automatically every few seconds.
- SQLite is configured in WAL mode for concurrent readers/writers.
- Updates use database revisions. If two users change the same dataset from stale versions, the second write is rejected and the latest server version is loaded instead of silently overwriting another user's work.

### Database authentication
Authentication is now server-side.

- Passwords are hashed with PBKDF2-SHA256 and unique salts.
- Passwords are never returned to the browser.
- Login sessions are stored in SQLite.
- Authentication uses an HttpOnly, SameSite session cookie.
- State-changing API calls require a CSRF token.
- The default inactivity timeout remains 30 minutes.
- Role permissions are checked by the server, not only by hidden/disabled UI controls.

## Run the shared server

Python 3 is the only runtime dependency. No `pip install` is required.

```bash
cd elevator-management-pwa
python3 server.py --host 0.0.0.0 --port 8080
```

Then open:

```text
http://SERVER-IP:8080
```

For example, if the computer running LiftOps has LAN address `192.168.1.50`, other devices on the same network can open:

```text
http://192.168.1.50:8080
```

All those devices will use the same database.

The SQLite database is created automatically at:

```text
data/liftops.db
```

You can choose another database location with:

```bash
LIFTOPS_DB=/path/to/liftops.db python3 server.py --host 0.0.0.0 --port 8080
```

## Demo accounts

On a new database:

- Administrator: `admin@liftops.local` / `admin123`
- Manager: `manager@liftops.local` / `manager123`
- Technician: `tech@liftops.local` / `tech123`

**Change these passwords before real deployment.** Administrator/Manager can manage accounts from User Management. When editing an existing user, leave the password box blank to keep the existing password.

## Role enforcement

### Administrator
- Full application access.
- Manages all account roles and approvals.
- Can grant/revoke Technician Remote Call access.

### Manager
- Full operational access.
- User Management is limited to Technician accounts.
- Can approve Technician accounts.
- Can grant/revoke Technician Remote Call access.

### Technician
- Dashboard: view.
- Elevators: view-only.
- Maintenance & Service: editable.
- Order Process: hidden.
- Installation: hidden.
- User Management: hidden.
- Activity Log: hidden.
- Remote Call: shown only when separately granted from User Management.

The backend independently blocks Technician writes to Elevator, Order, Installation and User data.

## Concurrent editing behavior

LiftOps synchronizes server state every 4 seconds. Writes include an expected database revision.

If another user has already changed the same dataset, LiftOps displays a conflict message and loads the latest server copy. This protects shared records from silent last-write-wins data loss.

SQLite is appropriate for a small/medium LiftOps installation with a central server. For a high-volume deployment with many simultaneous writers or multiple application servers, migrate the same API/data model to PostgreSQL.

## Android / PWA installation

For Android Home-screen installation in production, deploy LiftOps over **HTTPS**.

In Chrome on Android:

1. Open the LiftOps HTTPS address.
2. Use **Install LiftOps on this device**, or Chrome menu `⋮` → **Install app / Add to Home screen**.
3. Sign in normally after installation.

The PWA shell is cached, but shared operational data and authentication require a connection to the LiftOps server. API responses are deliberately never cached by the service worker.

## Production deployment notes

For an Internet-facing deployment:

- Put the Python server behind an HTTPS reverse proxy such as Nginx, Caddy or a managed load balancer.
- Set `LIFTOPS_SECURE_COOKIE=1` when HTTPS is terminated in front of the app and the proxy does not send `X-Forwarded-Proto: https`.
- Restrict database filesystem permissions and back up `data/liftops.db` regularly.
- Change all default demo passwords.
- Restrict firewall access to the intended network/users.
- For larger deployments, use PostgreSQL and a production application server instead of the included standard-library HTTP server.

## Docker (optional)

A simple `Dockerfile` is included. Persist `/app/data` as a volume so the SQLite database survives container replacement.

Example:

```bash
docker build -t liftops .
docker run -d --name liftops -p 8080:8080 -v liftops-data:/app/data liftops
```

## Files

- `server.py` — multi-user HTTP/API server, authentication, sessions and SQLite persistence.
- `data/liftops.db` — created automatically at first run; not included in the ZIP.
- `index.html`, `styles.css`, `app.js` — responsive PWA frontend.
- `manifest.json`, `sw.js`, icons — Android/desktop PWA support.

# 🏠 Student & Duty Management System

Student & Duty Management System is a web-based platform for managing dormitory students, rooms, floor rosters, duty schedules, completed duties, violations, replacements, and administrative workflows.
The system is built around PostgreSQL, a server-rendered administration panel, versioned student rosters, deterministic duty schedule generation, XLSX import, PDF/XLSX export, and Telegram notifications.
The schedule engine is fully deterministic and rule-based. The project does not use AI, LLMs, randomization, or external AI services.

## 🚀 Features

* Manage dormitories, floors, rooms, blocks, and students
* Maintain versioned floor rosters
* Import student rosters from XLSX files
* Preview roster changes before applying imports
* Track roster import history
* Generate deterministic duty schedules
* Configure duty shift templates and study shifts
* Balance student workload
* Enforce schedule hard constraints
* Apply soft constraints for better distribution
* Prevent excessive duty repetitions
* Maintain weekday and shift diversity
* Generate draft schedules
* Publish schedules with roster version tracking
* Preserve published schedules as immutable historical records
* Export schedules to PDF
* Export schedules to XLSX
* Manage completed and missed duties
* Record violations and explanations
* Manage duty replacements
* Send Telegram notifications
* Provide student-specific Telegram access
* Track absence counters
* Manage administrators and access scopes
* Support multiple administrator roles
* Configure system settings from the admin panel
* Run deterministic schedule generation without external services
* Validate core business rules with automated invariant tests
* Deploy the complete system to a VPS using Docker Compose

## 👨‍🎓 Student & Dormitory Management

The system separates the physical dormitory structure from student occupancy.

### Dormitory Structure

Rooms and blocks describe the physical structure of the dormitory.

The system supports:

* Floors
* Rooms
* Blocks
* Room-to-floor relationships
* Block-to-floor relationships

Physical capacity is not used as a source for schedule generation.

The number of students assigned to a room is determined by the current roster.

This means that:

* Empty rooms are valid
* Empty blocks are valid
* Empty floors are valid
* Student counts are derived from actual roster data

### Student Roster

The roster is the source of truth for schedule generation.
Only students from the currently confirmed roster version can become duty candidates.
The system does not generate candidates by traversing rooms or assuming that every room contains students.
This ensures that empty rooms, blocks, and floors do not create invalid schedule entries.

## 🗂️ Roster Versioning

Student composition changes are tracked through roster versions.

A new roster version is created when the composition of a floor changes, for example:

* Student moves
* Student additions
* Floor transfers
* Deactivation
* Eviction
* XLSX imports that change the composition

Roster versions provide a historical representation of who belonged to a floor at a specific point in time.

### Attribute Changes

Not every student change creates a new roster version.

Corrections to attributes such as:

* Name
* Faculty
* Course
* Group
* Study shift
* Telegram ID

are recorded through the audit system when the composition itself does not change.

This keeps roster history focused on actual composition changes.

## 📥 XLSX Import

The system includes a dedicated XLSX import workflow for updating student rosters.

The import process supports:

* XLSX file parsing
* Data validation
* Difference detection
* Import previews
* Ambiguity detection
* Explicit ambiguity resolution
* Import history
* Idempotent imports
* Rollback support
* No automatic deletion of students
* Controlled roster version creation

The import workflow allows administrators to review changes before applying them to the current roster.
Repeatedly importing the same data does not create unnecessary changes.

## 📊 Roster Snapshots

The system provides two different roster query models.

### Current Roster

`FloorRosterQueryService` reads the current state directly from the `students` table.

This provides:

* Current student information
* Current room assignments
* Current attributes
* Immediate attribute corrections

### Historical Roster

`RosterSnapshotQueryService` reads historical data from `roster_entries`.

Historical snapshots do not depend on current student or reference-table values.
Both services return the same `FloorRoster` DTO, allowing the same rendering and export components to work with current and historical data.
Historical snapshots preserve the student and room information that existed when the roster version was created.

## 📅 Duty Schedule Generation

The schedule generator creates duty assignments for a selected floor and month.

Schedule generation is:

* Deterministic
* Rule-based
* Reproducible
* Independent of AI
* Independent of randomness

The same roster, month, settings, and shift template produce the same schedule.
Stable student IDs are used for deterministic tie-breaking, and the generator stores the seed derived from its inputs.

### Schedule Hard Constraints

The generator enforces mandatory constraints including:

* Correct floor
* Confirmed roster version
* Active students only
* No duty overlaps
* Study-time restrictions
* Slot uniqueness
* Dates within the selected month

Hard constraints cannot be violated by the generated schedule.

### Schedule Soft Constraints

The generator also optimizes softer distribution rules:

* Workload balance
* Same-day avoidance
* Consecutive duty avoidance
* Intervals between duties
* Duty-type balance
* Previous-month workload balance
* Weekday diversity
* Day and shift diversity

Soft constraints are optimized while preserving all hard constraints.

## 🎯 Schedule Diversity

The generator includes additional mechanisms to avoid repetitive schedules.

The system tracks:

* Weekly duty repetitions
* Weekday repetitions
* Shift repetitions
* Day and shift combinations
* Student pair repetitions
* Previous-month distribution

Pair repetition is penalized using a quadratic cost model:

```text
pair penalty = n² × 90
```

The generator remains deterministic while applying these diversity rules.
Full seven-day coverage is not guaranteed for every student. Workload balance and constraint feasibility have higher priority.

### Deterministic Results

Schedule generation does not rely on random selection.

Given the same:

* Roster
* Month
* Configuration
* Shift template
* Historical inputs

the generated result remains reproducible.
This makes schedules easier to test, audit, compare, and debug.

## 📈 Schedule Feasibility

The system validates whether a requested schedule can actually be generated.
When a schedule is impossible, the generator can identify infeasible conditions instead of silently producing an invalid result.
The implementation includes Hall-condition-based feasibility checks for relevant assignment constraints.
This allows administrators to distinguish between:

* A valid schedule
* A difficult but feasible schedule
* A mathematically infeasible configuration

## 📤 Schedule Publication

Generated schedules initially exist as drafts.
Before publication, administrators can review:

* Floor
* Month
* Student count
* Duty count
* Roster version
* Generated schedule data

The system also checks whether the current roster has changed since generation.
If the roster has changed, publication is blocked unless the administrator explicitly chooses to publish using the previous roster version.

### Published Schedule Immutability

Published schedules preserve:

* Roster version
* Student names
* Room information
* Floor
* Duty assignments

Published data is stored as a historical snapshot.
Later student moves, renames, or roster changes do not rewrite previously published schedules.
This guarantees that historical schedules remain auditable.

## 🖨️ PDF & XLSX Export

Schedules can be exported into multiple formats.
Supported exports include:

* PDF
* XLSX

Both formats are generated from the same schedule dataset.
This prevents differences between printed schedules and spreadsheet exports.

### PDF Generation

PDF generation uses a system browser to render the schedule.
The browser executable can be configured through:

```bash
CHROME_PATH
```

This allows the application to work with different Chromium or Chrome installations on development and production systems.

## ✅ Duty Management

The administration panel provides tools for managing actual duty execution.
Administrators can:

* View scheduled duties
* Mark duties as completed
* Record missed duties
* Create replacements
* Review violations
* Review explanations

Students cannot self-confirm their own duties.
The system does not require:

* Geolocation
* Photos
* QR codes
* Student self-confirmation

## ⚠️ Violations & Explanations

The system distinguishes between recorded absences and confirmed violations.
Two separate counters are maintained.

### Absence Counter

This represents all recorded missed duties visible to the student.

### Violation Counter

This counter is used for the configured violation threshold and only includes administrator-confirmed violations.
This prevents every recorded absence from automatically becoming a confirmed violation.

## 🔄 Duty Replacements

Administrators can manage replacement assignments when a scheduled student cannot perform a duty.
Replacement records remain part of the duty history and can be audited independently from the original schedule assignment.
The original published schedule is not rewritten when a replacement is recorded.

## 🤖 Telegram Bot

The project includes a Telegram bot for student-facing functionality.
The architecture separates Telegram transport from application logic:

```text
Telegram Adapter
       │
       ▼
   BotService
       │
       ▼
Application Services
       │
       ▼
   PostgreSQL
```

Telegram handlers do not contain database or business logic.

### Telegram Identity

Students are identified exclusively through their Telegram identity.
The bot does not accept external parameters such as:

* `student_id`
* `floor_id`
* `schedule_id`

from users to determine their identity.
The Telegram account is resolved through `telegram_id`.
This prevents users from accessing another student's data by changing an identifier in a request.

## 🔔 Notifications

The notification system is separated from the Telegram adapter.

```text
Scheduler Worker
       │
       ▼
Notification Service
       │
       ▼
Telegram Adapter
```

Notifications support:

* Scheduled reminders
* Duty-related notifications
* Idempotent delivery
* Retry handling
* Failed notification tracking

Notifications use a unique constraint to prevent duplicate delivery.
Failed notifications can be retried up to five times before being marked as failed.

## 🖥️ Administration Panel

The system includes a server-rendered web administration panel.
The interface does not require a frontend build step.
The administration panel includes pages for:

1. Dashboard
2. Floors
3. Rooms and blocks
4. Floor roster
5. XLSX import
6. Import history
7. Schedule generation
8. Schedules
9. Duties
10. Violations
11. Replacements
12. Settings

The interface is responsive and supports both desktop and mobile layouts.
Wide tables remain horizontally scrollable inside their containers, while mobile navigation becomes a horizontal navigation strip.

## 🔐 Authentication & Access Control

The administration panel uses role-based access control.
Supported roles include:

### Superadmin

Full access to dormitories, floors, reference data, and administrative functionality.

### Dorm Admin

Access to the assigned dormitory and its reference data.

### Floor Admin

Access only to floors explicitly assigned through `admin_floor_scopes`.
Access is based on database configuration rather than hardcoded floor numbers.
Every floor-specific handler validates the current administrator's scope before accessing data.
Unauthorized floor access results in a `403` response or redirects to the administrator's permitted floor context.

## ⚙️ System Settings

Important operational settings are stored as database records and can be managed through the administration panel.
Configurable data includes:

* Faculties
* Study shifts
* Study times
* Floors
* Duty shift templates
* Duty shift times
* Absence threshold
* Violation period
* Reminder time
* Print parameters

The system avoids hardcoding values such as specific floor numbers, faculties, or shift counts.
Configuration that represents business data is stored in database tables rather than application constants.

## 🗄️ Database & Data Integrity

The application uses PostgreSQL as its primary database.
The database is designed around strong relational constraints and business invariants.

### Floor Isolation

Floor relationships are protected using composite foreign keys.
For example:

```text
students(room_id, floor_id)
    → rooms(id, floor_id)
```

and:

```text
duty_schedules(roster_version_id, floor_id)
    → roster_versions(id, floor_id)
```

This prevents records from one floor from being accidentally associated with another floor.

### Historical Data

Historical records are intentionally immutable.
The following data is insert-only:

* `roster_entries`
* `duty_changes`
* `audit_log`

Database triggers protect these records from modification and deletion.

### Data vs Code

Business configuration is stored as data whenever possible.
Examples include:

* Floors
* Faculties
* Study shifts
* Shift templates
* Distribution rules

Enums are used only where introducing a new value would require application logic.

## 📝 Audit Log

The audit system records important changes that affect the integrity and history of the application.
The audit trail helps administrators understand:

* What changed
* When it changed
* Which entity was affected
* Which administrative operation caused the change

Audit records are immutable.
This provides a reliable historical record for administrative operations.

## 🧪 Testing

The project contains an extensive automated invariant test suite.
Tests are located under:

```text
tests/
└── invariants/
```

Run the full test suite with:

```bash
npm test
```

The current test suite contains:

```text
198 passing
0 deferred
```

### Tested Invariants

The tests cover:

* Floor isolation
* Empty room validity
* Empty block validity
* Empty floor validity
* Roster versioning
* Published schedule immutability
* Print configuration
* Empty-room printing
* PDF/XLSX dataset consistency
* No hardcoded floor numbers
* No hardcoded shift counts
* Import idempotence
* Import diff generation
* Import rollback
* Ambiguity handling
* No automatic student deletion
* Schedule hard constraints
* Schedule soft constraints
* Leap years
* Sundays
* Workload distribution
* Hall feasibility
* Draft and publication workflows
* Schedule history
* Deterministic generation
* Weekday diversity
* Shift diversity
* Student pair repetition limits
* Telegram architecture boundaries
* Notification idempotence

The project also contains an explicit invariant preventing AI and LLM dependencies:

```text
tests/invariants/no-ai.test.ts
```

## 🧱 Architecture

The application follows a layered architecture that separates domain logic, application services, infrastructure, and delivery mechanisms.

```text
Web Admin
    │
    ▼
API / Application Services
    │
    ├── Roster Services
    ├── Import Services
    ├── Schedule Services
    ├── Duty Services
    ├── Export Services
    ├── Notification Services
    └── Authentication
            │
            ▼
        PostgreSQL
```

Telegram uses the same application services instead of implementing separate business logic:

```text
Telegram
    │
    ▼
Telegram Adapter
    │
    ▼
BotService
    │
    ▼
Application Services
    │
    ▼
PostgreSQL
```

Background processing is handled by a dedicated worker:

```text
Scheduler Worker
      │
      ▼
Notification Service
      │
      ▼
Telegram Adapter
```

## 🛠️ Tech Stack

* Runtime: Node.js
* Language: TypeScript
* Database: PostgreSQL 14+
* Web: Server-rendered administration panel
* API: TypeScript backend
* Telegram: Telegram Bot API
* Import: XLSX
* Export: PDF / XLSX
* PDF Rendering: Chromium / Chrome
* Testing: Node.js test suite
* Database Migrations: PostgreSQL migrations
* Deployment: Docker Compose
* Reverse Proxy: Nginx

The project requires:

```text
Node.js >= 22
PostgreSQL >= 14
```

## 📂 Project Structure

```text
project/
├── migrations/
│
├── src/
│   ├── domain/
│   │   ├── roster.ts
│   │   └── import.ts
│   │
│   ├── services/
│   │   ├── rosterService/
│   │   ├── importService/
│   │   ├── ImportSource/
│   │   ├── xlsxSource/
│   │   ├── query/
│   │   ├── export/
│   │   ├── seed/
│   │   ├── bot/
│   │   └── notifications/
│   │
│   ├── adapters/
│   │   └── telegram/
│   │
│   ├── worker/
│   │
│   ├── api/
│   │
│   ├── services/
│   │   └── auth/
│   │
│   └── main/
│
├── tests/
│   └── invariants/
│
├── docs/
│   ├── duty-system-design.html
│   └── duty-system-spec.html
│
├── DEPLOY.md
├── docker-compose.yml
├── .env.example
├── package.json
└── README.md
```

## 📦 Installation

To install the Student & Duty Management System locally:

1. Clone the repository.

2. Install dependencies:

```bash
npm install
```

3. Create the environment configuration:

```bash
cp .env.example .env
```

4. Create the application databases:

```bash
createdb dorm_duty
createdb dorm_duty_test
```

5. Run database migrations and seed data:

```bash
npm run migrate
npm run seed
```

6. Run the test suite:

```bash
npm test
```

Make sure PostgreSQL 14+ and Node.js 22+ are installed before starting the application.

## 💻 Usage

The main administrative workflow is:

```text
Admin Login
     │
     ▼
Floors
     │
     ▼
Rooms / Blocks
     │
     ▼
Floor Roster
     │
     ▼
XLSX Import
     │
     ▼
Review Changes
     │
     ▼
Confirm Roster
     │
     ▼
Generate Schedule
     │
     ▼
Review Schedule
     │
     ▼
Export PDF / XLSX
     │
     ▼
Publish
     │
     ▼
Manage Duties
     │
     ▼
Violations / Replacements
```

## 🧰 Demo Commands

The repository contains several demonstration scripts.

### Import Demo

```bash
npx tsx src/seed/importDemo.ts
```

### Export Demo

```bash
npx tsx src/seed/exportDemo.ts
```

### Schedule Demo

```bash
npx tsx src/seed/scheduleDemo.ts 9 2026
```

### Infeasible Schedule Demo

```bash
npx tsx src/seed/infeasibleDemo.ts
```

### Schedule Export Demo

```bash
npx tsx src/seed/scheduleExportDemo.ts
```

### Determinism Check

```bash
npx tsx src/seed/determinismCheck.ts
```

These commands are intended for development, testing, and demonstrating the core application workflows.

## 🤖 Telegram Setup

The Telegram bot can be started with:

```bash
TELEGRAM_BOT_TOKEN=... npx tsx src/main/bot.ts
```

The background worker can be started with:

```bash
TELEGRAM_BOT_TOKEN=... npx tsx src/main/worker.ts
```

The bot and worker use the same application services as the administration system.
Business rules are not duplicated inside Telegram handlers.

## 👤 Create an Administrator

An administrator can be created using:

```bash
npm run admin:create -- admin@example.org "password" dorm_admin
```

The available roles are:

```text
superadmin
dorm_admin
floor_admin
```

Floor-specific permissions are configured through administrator floor scopes rather than hardcoded application logic.

## 🌐 Run the Administration Panel

Start the backend API with:

```bash
npm run api
```

The administration interface is server-rendered and does not require a separate frontend build process.

## 🐳 Deployment

The application is designed to run on a VPS.

The recommended production architecture is:

```text
Internet
   │
   ▼
 Nginx
   │
   ├── Admin Web
   │
   └── Backend API
          │
          ├── PostgreSQL
          ├── Telegram Bot
          ├── Worker / Scheduler
          └── Chromium
```

Docker Compose can be used to start the production environment:

```bash
cp .env.example .env

docker compose up -d
```

Create the first administrator:

```bash
docker compose exec api \
  npx tsx src/main/createAdmin.ts \
  admin@example.org "password" dorm_admin
```

Database migrations must be completed before starting services that depend on the database.

Detailed deployment instructions are available in:

```text
DEPLOY.md
```

## 🔒 Security

Security is enforced at multiple application layers.
The system includes:

* Role-based administrator access
* Floor-level access scopes
* Composite foreign keys for floor isolation
* Telegram identity based on `telegram_id`
* Immutable historical records
* Database-level integrity constraints
* Audit logging
* Controlled schedule publication
* No external student identifiers accepted from Telegram users

The system does not use Firebase or external authentication services for its core architecture.

## 🧩 Architecture Invariants

Several architectural rules are intentionally enforced by automated tests.

### Structure Is Not Occupancy

Physical structure and student occupancy are separate concepts.

```text
rooms / blocks
      │
      │ physical structure
      ▼
roster / students
      │
      │ current occupancy
      ▼
schedule generation
```

### Roster Is the Source of Truth

Schedule generation uses the confirmed roster.
It does not infer students from room structure.

### Published Data Is Historical

Published schedules preserve the roster and student information used at generation time.
Later changes cannot rewrite historical schedules.

### Configuration Is Data

Operational reference data is stored in PostgreSQL rather than hardcoded into TypeScript.

### No AI

The schedule generator and core business logic do not depend on:

* AI
* LLMs
* Random generation
* External AI APIs

This is also validated by the automated test suite.

## 📚 Documentation

The repository contains additional technical documentation:

```text
docs/
├── duty-system-design.html
└── duty-system-spec.html
```

The documentation describes the system design, domain rules, workflows, and implementation requirements.

## 📋 Current Status

The project is currently at stage:

```text
M6
```

The administration panel is ready for VPS deployment.
The implemented system includes:

* Student and roster management
* XLSX import
* Versioned rosters
* Deterministic schedule generation
* Schedule diversity
* Draft and publication workflow
* PDF/XLSX export
* Duty tracking
* Violations
* Replacements
* Telegram integration
* Notifications
* Role-based administration
* Automated invariant testing
* Docker-based deployment

The current automated test suite contains:

```text
198 passing
0 deferred
```

## ❓ Open Configuration Questions

Some operational parameters depend on real dormitory data and must be configured before final production rollout.

These include:

1. Actual study time ranges for each shift.
2. The final workflow for who marks completed duties.
3. Actual student and room counts for floors 6 and 7.
4. Whether floors 6 and 7 use blocks or flat room numbering.

These values are intentionally kept configurable instead of being hardcoded into the application.

## 📝 License

No open-source license is currently specified in the repository.

If you plan to distribute the project as open source, add an appropriate `LICENSE` file.

## 📬 Contact

For questions, suggestions, bug reports, or project discussions, use the repository's issue tracker or project documentation.

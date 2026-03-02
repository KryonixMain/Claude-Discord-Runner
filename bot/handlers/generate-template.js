import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { EmbedBuilder } from "discord.js";
import { PROJECT_DIR } from "../lib/paths.js";
import { ensureDir } from "../lib/helpers.js";

const TEMPLATES_DIR = join(PROJECT_DIR, "Templates");
const AGENT_TEMPLATES_DIR = join(TEMPLATES_DIR, "Agents");

const SESSION_TEMPLATES = {
  bugfix: {
    label: "Bug Fix",
    description: "Diagnose and fix a specific bug",
    generate: (num) => `<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 300000,
    "defaultModel": "claude-sonnet-4-5"
  },
  "prompts": {
    "1": { "model": "claude-sonnet-4-5", "maxTurns": 50, "timeoutMs": 180000 },
    "2": { "model": "claude-sonnet-4-5", "maxTurns": 100, "timeoutMs": 300000 },
    "3": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 },
    "4": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 }
  }
}
-->

# Session ${num} — Bug Fix: {Bug Title}

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: \`### PROMPT X COMPLETED\`

---

## Prompt 1 — Diagnose the Bug [FULLSTACK] [LOW_RISK]

Investigate the following bug:

**Bug description:** {Describe the bug here}
**Steps to reproduce:** {Steps}
**Expected behavior:** {What should happen}
**Actual behavior:** {What happens instead}

Tasks:
1. Locate the root cause of the bug
2. Document the affected files and code paths
3. Identify any related issues or side effects

### Completion Checklist
- [ ] Root cause identified and documented
- [ ] Affected files listed
- [ ] Reproduction confirmed

---

## Prompt 2 — Implement the Fix [FULLSTACK]

Apply the fix for the bug diagnosed in Prompt 1.

Tasks:
1. Implement the minimal fix for the root cause
2. Add or update tests to cover the bug scenario
3. Verify no regressions in related functionality

### Completion Checklist
- [ ] Fix implemented
- [ ] Tests added or updated
- [ ] No regressions introduced

---

## Prompt 3 — Security Review [SECURITY]

Review ALL changes made in this session for security implications.
Write report to Security/ directory.

### Completion Checklist
- [ ] Security report written
- [ ] All modified files reviewed
- [ ] No new vulnerabilities introduced

---

## Prompt 4 — Summary [MANAGER]

Review all prompts in this session for completeness.
Write summary to Logs/summary-Session${num}.md.

### Completion Checklist
- [ ] Summary written
- [ ] All checklist items verified
- [ ] Follow-ups documented if needed

---
`,
  },

  feature: {
    label: "New Feature",
    description: "Implement a new feature end-to-end",
    generate: (num) => `<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 300000,
    "defaultModel": "claude-opus-4-5"
  },
  "prompts": {
    "1": { "model": "claude-opus-4-5", "maxTurns": 150, "timeoutMs": 600000 },
    "2": { "model": "claude-opus-4-5", "maxTurns": 100, "timeoutMs": 300000 },
    "3": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 },
    "4": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 }
  }
}
-->

# Session ${num} — Feature: {Feature Name}

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: \`### PROMPT X COMPLETED\`

---

## Prompt 1 — Implement the Feature [FULLSTACK]

Implement the following feature:

**Feature description:** {Describe the feature}
**Requirements:**
- {Requirement 1}
- {Requirement 2}
- {Requirement 3}

Tasks:
1. Implement all required components, routes, and logic
2. Write tests for all new functionality
3. Update any existing code that needs to integrate with the new feature

### Completion Checklist
- [ ] Feature fully implemented
- [ ] All requirements met
- [ ] Tests written and passing
- [ ] Integration with existing code verified

---

## Prompt 2 — Database & API Changes [DATABASE]

Apply any database or API changes required for the feature.

Tasks:
1. Create migrations if needed
2. Add or update API endpoints
3. Ensure all queries use parameterized statements

### Completion Checklist
- [ ] Migrations created (if applicable)
- [ ] API endpoints tested
- [ ] Rollback migration provided (if applicable)

---

## Prompt 3 — Security Review [SECURITY]

Review ALL changes made in this session for security implications.
Write report to Security/ directory.

### Completion Checklist
- [ ] Security report written
- [ ] All modified files reviewed

---

## Prompt 4 — Summary [MANAGER]

Review all prompts in this session for completeness.
Write summary to Logs/summary-Session${num}.md.

### Completion Checklist
- [ ] Summary written
- [ ] All checklist items verified

---
`,
  },

  refactor: {
    label: "Refactor",
    description: "Refactor existing code for better structure",
    generate: (num) => `<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 300000,
    "defaultModel": "claude-opus-4-5"
  },
  "prompts": {
    "1": { "model": "claude-opus-4-5", "maxTurns": 150, "timeoutMs": 600000 },
    "2": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 },
    "3": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 }
  }
}
-->

# Session ${num} — Refactor: {Target Area}

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: \`### PROMPT X COMPLETED\`

---

## Prompt 1 — Refactor Implementation [FULLSTACK]

Refactor the following area:

**Target:** {Describe what to refactor}
**Goals:**
- {Goal 1: e.g., reduce duplication}
- {Goal 2: e.g., improve testability}
- {Goal 3: e.g., clearer separation of concerns}

Tasks:
1. Refactor the target code according to the goals
2. Ensure all existing tests still pass
3. Add tests for any new abstractions
4. Do NOT change external behavior

### Completion Checklist
- [ ] Refactoring complete
- [ ] All existing tests pass
- [ ] No behavioral changes
- [ ] New abstractions tested

---

## Prompt 2 — Security Review [SECURITY]

Review ALL changes made in this session.
Write report to Security/ directory.

### Completion Checklist
- [ ] Security report written

---

## Prompt 3 — Summary [MANAGER]

Review all prompts for completeness.
Write summary to Logs/summary-Session${num}.md.

### Completion Checklist
- [ ] Summary written

---
`,
  },

  docs: {
    label: "Documentation",
    description: "Write or update project documentation",
    generate: (num) => `<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 120000,
    "defaultModel": "claude-sonnet-4-5"
  },
  "prompts": {
    "1": { "model": "claude-sonnet-4-5", "maxTurns": 80, "timeoutMs": 300000 },
    "2": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 }
  }
}
-->

# Session ${num} — Documentation: {Topic}

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: \`### PROMPT X COMPLETED\`

---

## Prompt 1 — Write Documentation [FULLSTACK] [LOW_RISK]

Write comprehensive documentation for:

**Topic:** {Describe what to document}
**Audience:** {Developers / Users / Both}

Tasks:
1. Write clear, structured documentation
2. Include code examples where appropriate
3. Add table of contents for long documents
4. Verify all code references are accurate

### Completion Checklist
- [ ] Documentation written
- [ ] Code examples tested
- [ ] All references accurate

---

## Prompt 2 — Summary [MANAGER]

Review documentation for completeness and accuracy.
Write summary to Logs/summary-Session${num}.md.

### Completion Checklist
- [ ] Summary written

---
`,
  },

  migration: {
    label: "Migration",
    description: "Database or system migration",
    generate: (num) => `<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 300000,
    "defaultModel": "claude-opus-4-5"
  },
  "prompts": {
    "1": { "model": "claude-opus-4-5", "maxTurns": 100, "timeoutMs": 300000 },
    "2": { "model": "claude-opus-4-5", "maxTurns": 100, "timeoutMs": 300000 },
    "3": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 },
    "4": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 }
  }
}
-->

# Session ${num} — Migration: {Migration Description}

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: \`### PROMPT X COMPLETED\`

---

## Prompt 1 — Forward Migration [DATABASE] [CRITICAL_PATH]

Implement the forward migration:

**Migration:** {Describe the migration}
**Affected tables/systems:** {List affected areas}

Tasks:
1. Write the forward migration script
2. Test with sample data
3. Document any breaking changes

### Completion Checklist
- [ ] Forward migration script written
- [ ] Migration tested
- [ ] Breaking changes documented

---

## Prompt 2 — Rollback Migration [DATABASE] [CRITICAL_PATH]

Implement the rollback migration:

Tasks:
1. Write the rollback script that fully reverses the forward migration
2. Test rollback with sample data
3. Verify data integrity after rollback

### Completion Checklist
- [ ] Rollback script written
- [ ] Rollback tested
- [ ] Data integrity verified

---

## Prompt 3 — Security Review [SECURITY]

Review ALL migration scripts for security.
Write report to Security/ directory.

### Completion Checklist
- [ ] Security report written

---

## Prompt 4 — Summary [MANAGER]

Review all prompts for completeness.
Write summary to Logs/summary-Session${num}.md.

### Completion Checklist
- [ ] Summary written

---
`,
  },

  "security-audit": {
    label: "Security Audit",
    description: "Full security audit of the codebase",
    generate: (num) => `<!--
SESSION OVERRIDE CONFIG
{
  "session": {
    "pauseAfterMs": 300000,
    "defaultModel": "claude-opus-4-5"
  },
  "prompts": {
    "1": { "model": "claude-opus-4-5", "maxTurns": 150, "timeoutMs": 600000 },
    "2": { "model": "claude-opus-4-5", "maxTurns": 100, "timeoutMs": 300000 },
    "3": { "model": "claude-sonnet-4-5", "maxTurns": 20, "timeoutMs": 120000 }
  }
}
-->

# Session ${num} — Security Audit

Execute ALL of the following prompts in order.
Do NOT wait for user input between prompts.
Continue automatically once the completion checklist of a prompt is fulfilled.
Mark each completed prompt with: \`### PROMPT X COMPLETED\`

---

## Prompt 1 — Full Security Audit [SECURITY] [CRITICAL_PATH]

Perform a comprehensive security audit:

**Scope:** {Describe scope — entire codebase / specific module / API layer}

Tasks:
1. Review all authentication and authorization flows
2. Check for injection vulnerabilities (SQL, XSS, command injection)
3. Audit input validation and sanitization
4. Review secrets management and environment variable handling
5. Check dependency vulnerabilities
6. Review CORS, CSP, and other security headers
7. Assess rate limiting and DDoS protections

Write a detailed report to Security/ directory.

### Completion Checklist
- [ ] Auth flows reviewed
- [ ] Injection vulnerabilities checked
- [ ] Input validation audited
- [ ] Secrets management reviewed
- [ ] Dependencies scanned
- [ ] Security headers reviewed
- [ ] Full report written

---

## Prompt 2 — Fix Critical Issues [FULLSTACK] [CRITICAL_PATH]

Fix all CRITICAL findings from the security audit.

Tasks:
1. Address each CRITICAL finding from the report
2. Mark fixed items in the report with FIXED
3. Add tests for security fixes where possible

### Completion Checklist
- [ ] All CRITICAL items fixed
- [ ] Report updated with FIXED markers
- [ ] Security tests added

---

## Prompt 3 — Summary [MANAGER]

Review all prompts for completeness.
Write summary to Logs/summary-Session${num}.md.

### Completion Checklist
- [ ] Summary written

---
`,
  },
};

const AGENT_TEMPLATES = {
  fullstack: {
    label: "Fullstack Agent",
    generate: () => `# Fullstack Agent Template

## Role
Activate when a prompt is tagged: [FULLSTACK]

## Default Configuration
- Model: claude-opus-4-5
- Max Turns: 150
- Risk Level: LOW_RISK (default)

## Responsibilities
- Implement frontend components, pages, and API routes
- Write clean, typed code
- Follow existing file structure and naming conventions
- Every new component must have tests
- Use existing UI component library
- API routes must validate all inputs

## Output Structure
- Modified/created files listed at the end of each prompt
- Test results summarized
- Any deviations from the plan documented

## Completion Checklist Template
- [ ] All code changes implemented
- [ ] Tests written and passing
- [ ] No linting errors
- [ ] Integration verified

## Risk Defaults
- Default: [LOW_RISK]
- File creation: [LOW_RISK]
- API changes: [REVIEW_REQUIRED]
- Auth changes: [CRITICAL_PATH]

## Prompt Scaffolding
\`\`\`
## Prompt N — {Description} [FULLSTACK] [{RISK_LEVEL}]

{Task description}

Tasks:
1. {Task 1}
2. {Task 2}

### Completion Checklist
- [ ] {Checklist item 1}
- [ ] {Checklist item 2}
\`\`\`
`,
  },

  database: {
    label: "Database Agent",
    generate: () => `# Database Agent Template

## Role
Activate when a prompt is tagged: [DATABASE]

## Default Configuration
- Model: claude-opus-4-5
- Max Turns: 100
- Risk Level: REVIEW_REQUIRED (default)

## Responsibilities
- Write and apply database migrations
- Design schemas with proper constraints
- All queries must use parameterized statements
- Write rollback migrations for every forward migration
- Document all tables and columns

## Output Structure
- Migration files in db/migrations/
- Rollback files paired with forward migrations
- Updated TypeScript types

## Completion Checklist Template
- [ ] Forward migration written
- [ ] Rollback migration written
- [ ] Parameterized queries only
- [ ] Types updated

## Risk Defaults
- Schema changes: [CRITICAL_PATH]
- Read queries: [LOW_RISK]
- Write queries: [REVIEW_REQUIRED]
- Data migration: [CRITICAL_PATH]
`,
  },

  security: {
    label: "Security Agent",
    generate: () => `# Security Agent Template

## Role
Activate when a prompt is tagged: [SECURITY]

## Default Configuration
- Model: claude-opus-4-5
- Max Turns: 100
- Risk Level: N/A (read-only)

## Responsibilities
- Review every file created or modified in the session
- Check all layers: frontend, backend, database
- Write structured reports to Security/ directory
- Never truncate findings

## Output Structure
- Report file: Security/security-report-{prompt-name}-{date}.md
- Sections: CRITICAL, WARNING, INFO, Checked (no findings)

## Completion Checklist Template
- [ ] All modified files reviewed
- [ ] Report written with all sections
- [ ] CRITICAL summary included
`,
  },

  manager: {
    label: "Manager Agent",
    generate: () => `# Manager Agent Template

## Role
Activate when a prompt is tagged: [MANAGER]

## Default Configuration
- Model: claude-sonnet-4-5
- Max Turns: 20
- Risk Level: LOW_RISK

## Responsibilities
- Review session output for completeness
- Cross-check completion checklists
- Identify gaps and incomplete work
- Write session summary
- Generate follow-up prompts if needed

## Output Structure
- Summary: Logs/summary-SessionN.md
- Follow-ups: Sessions/followup-SessionN.md (if needed)

## Completion Checklist Template
- [ ] Summary written
- [ ] All checklists verified
- [ ] Follow-ups documented
`,
  },
};

export async function handleGenerateTemplate(interaction) {
  const which = interaction.options.getString("which");

  // Check if it's a session template
  if (SESSION_TEMPLATES[which]) {
    const tmpl = SESSION_TEMPLATES[which];
    ensureDir(TEMPLATES_DIR);
    const outFile = join(TEMPLATES_DIR, `${which}.template.md`);

    if (existsSync(outFile)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Template already exists")
            .setDescription(`\`Templates/${which}.template.md\` already exists.\nDelete it first if you want to regenerate.`)
            .setColor(0xfee75c),
        ],
        ephemeral: true,
      });
    }

    writeFileSync(outFile, tmpl.generate(1));
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Session template created: ${tmpl.label}`)
          .setDescription(
            `\`Templates/${which}.template.md\`\n\n` +
            `${tmpl.description}\n\n` +
            `Edit the template to customize, then copy to Sessions/ as Session{N}.md.`,
          )
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
  }

  // Check if it's an agent template
  if (AGENT_TEMPLATES[which]) {
    const tmpl = AGENT_TEMPLATES[which];
    ensureDir(AGENT_TEMPLATES_DIR);
    const outFile = join(AGENT_TEMPLATES_DIR, `${which}.template.md`);

    if (existsSync(outFile)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Template already exists")
            .setDescription(`\`Templates/Agents/${which}.template.md\` already exists.`)
            .setColor(0xfee75c),
        ],
        ephemeral: true,
      });
    }

    writeFileSync(outFile, tmpl.generate());
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Agent template created: ${tmpl.label}`)
          .setDescription(
            `\`Templates/Agents/${which}.template.md\`\n\n` +
            `This template defines the ${tmpl.label} role, default config, and prompt scaffolding.`,
          )
          .setColor(0x57f287)
          .setTimestamp(),
      ],
    });
  }

  // Unknown template
  const allOptions = [
    ...Object.entries(SESSION_TEMPLATES).map(([k, v]) => `\`${k}\` — ${v.description}`),
    ...Object.entries(AGENT_TEMPLATES).map(([k, v]) => `\`${k}\` — ${v.label} (agent)`),
  ];

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Unknown template type")
        .setDescription(`Available templates:\n${allOptions.join("\n")}`)
        .setColor(0xed4245),
    ],
    ephemeral: true,
  });
}

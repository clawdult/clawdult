# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Clawdult is an AI Agent Workstation Provisioner - a system for provisioning dedicated EC2 instances as isolated workstations for AI agents. It provides security controls through IAM permission boundaries, cost management via AWS Budgets, and agent configuration through an interactive CLI.

## Commands

```bash
# Build
npm run build            # Compile TypeScript + run tests
npm run dev              # TypeScript watch mode
npm run clean            # Remove dist/ directory

# Development
npm run start            # Run CLI from dist/
npm link                 # Link to system PATH for local testing

# Quality
npm run lint             # Run ESLint
npm run format           # Format with Prettier
npm run format:check     # Check formatting
npm test                 # Run Jest tests

# AMI Building
cd packer && packer build clawdult-ami.pkr.hcl
```

## Architecture

### CLI Commands (`src/cli/commands/`)

| Command                 | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `create`                | Provision new workstation with interactive profile selection  |
| `destroy`               | Terminate workstation and clean up IAM resources              |
| `list`                  | List all managed workstations across regions                  |
| `status`                | Show detailed workstation status                              |
| `ssh`                   | SSH into workstation (prefers Tailscale IP)                   |
| `logs`                  | View agent/audit/cli logs via SSH                             |
| `config`                | View and modify global configuration                          |
| `setup-admin`           | Bootstrap AWS credentials, IAM, budgets, and AMI              |
| `secrets`               | Retrieve workstation secrets (e.g., `secrets openclaw-token`) |
| `completion`            | Install/uninstall shell tab completions (bash/zsh/fish)       |
| `profiles keys`         | Manage API key profiles (Claude, OpenAI, Grok, Gemini)        |
| `profiles budget`       | Manage AWS spending limit profiles                            |
| `profiles connectivity` | Manage Tailscale and messaging channel profiles               |
| `cp`                    | Copy files to/from workstation via rsync                      |
| `gateway`               | Get OpenClaw gateway connection info (URL, token)             |

### Services (`src/services/`)

| Service                    | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `config.ts`                | Global config management via cosmiconfig (`~/.clawdult/config.yaml`)    |
| `key-profiles.ts`          | API key profile storage (metadata in JSON, keys in keychain)            |
| `secrets.ts`               | Secure credential storage via keytar with encrypted file fallback       |
| `aws-bootstrap/`           | AWS account setup (5 modules: credentials, IAM, budget, CLI, constants) |
| `aws-client.ts`            | AWS SDK client initialization and region configuration                  |
| `aws-retry.ts`             | Retry with exponential backoff for AWS API calls                        |
| `ec2.ts`                   | EC2 lifecycle: launch, terminate, security groups, key pairs            |
| `ssm.ts`                   | Push secrets and configuration to SSM Parameter Store                   |
| `iam.ts`                   | Create/delete IAM roles, instance profiles, permission boundaries       |
| `budget-profiles.ts`       | Budget profile storage and AWS Budgets integration                      |
| `connectivity-profiles.ts` | Tailscale, OpenClaw, and messaging channel profiles                     |
| `github-agent.ts`          | GitHub agent account and PAT token management                           |
| `openclaw-models.ts`       | OpenClaw model catalog with dynamic fetching                            |
| `profile-store.ts`         | Generic JSON file-based profile storage                                 |

### Schemas (`src/schemas/config.ts`)

| Schema                      | Description                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InstanceTypeSchema`        | Allowed EC2 types: t3.micro-xlarge, m6i.large/xlarge                                                                                                                                                        |
| `RegionSchema`              | Allowed AWS regions (10 regions across US/EU/AP)                                                                                                                                                            |
| `WorkstationConfigSchema`   | Name, instanceType, region, volumeSize (20-500 GB), owner, tags                                                                                                                                             |
| `GlobalConfigSchema`        | Default settings, SSH keys, AWS profile, GitHub accounts, sshKeyPaths map                                                                                                                                   |
| `KeyProfileSchema`          | API key profile metadata with has\*Key booleans (incl. hasClaudeSetupToken)                                                                                                                                 |
| `BudgetProfileSchema`       | Monthly limit, email, alert thresholds (default: 50/80/100%)                                                                                                                                                |
| `ConnectivityProfileSchema` | Tailscale, OpenClaw (gateway mode: local/tailscale-serve/funnel/none), DM policies, automation (cron/webhooks), channels (Discord, Slack, Telegram, Google Chat, Teams, Matrix, WebChat, BlueBubbles, Zalo) |
| `ToolsConfigSchema`         | Tool availability flags (claudeCode, codex, grok, gemini, playwright, docker)                                                                                                                               |
| `GitHubAgentAccountSchema`  | GitHub agent username, email, creation date                                                                                                                                                                 |

### Ansible Roles (`ansible/roles/`)

| Role            | Installs/Configures                                                                           |
| --------------- | --------------------------------------------------------------------------------------------- |
| `clawdult_base` | Directory structure, Node.js 22, Python 3.12, Go 1.22, Rust, tmpfs secrets mount, kill-switch |
| `docker`        | Docker CE with overlay2 driver, log rotation (100MB × 3 files)                                |
| `ai_clis`       | Claude Code, OpenAI Codex, GitHub CLI, AWS CLI v2, audit wrapper scripts                      |
| `tailscale`     | Tailscale VPN with SSM-based auth key and IP registration                                     |
| `openclaw`      | OpenClaw gateway systemd service with token-based auth                                        |
| `playwright`    | Playwright MCP server on port 8931 with browser dependencies                                  |
| `audit`         | auditd with clawdult rules + CloudWatch agent for log aggregation                             |

### IAM Policies (`policies/`)

| Policy                         | Purpose                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `agent-base-policy.json`       | Agent runtime permissions: SSM params, CloudWatch logs, S3 workspace, EC2 self-stop  |
| `clawdult-provisioner.json`    | Provisioner permissions: EC2/IAM/Budgets/SSM/S3 management for clawdult-\* resources |
| `spending-limit-boundary.json` | Permission boundary: blocks expensive instances, IAM escalation, billing changes     |

## Key Concepts

**Key Profiles**: Named collections of API keys stored securely via keytar. Metadata in `~/.clawdult/key-profiles/*.json`, actual keys in system keychain.

**Connectivity Profiles**: Tailscale auth keys and messaging platform tokens (Discord, Slack, Telegram). Metadata in `~/.clawdult/connectivity-profiles/*.json`.

**Budget Profiles**: AWS spending limits with email notifications. Applied as a joint budget for all clawdult workstations.

**Permission Boundaries**: IAM policies that restrict agents from launching expensive instances (only t3/m6i allowed), IAM privilege escalation, and account modifications.

## Data Locations

### CLI Host (`~/.clawdult/`)

- `config.yaml` - Global configuration
- `key-profiles/` - API key profile metadata (JSON)
- `budget-profiles/` - Budget profile metadata (JSON)
- `connectivity-profiles/` - Connectivity profile metadata (JSON)
- `logs/` - CLI operation logs

### Workstation (`/opt/clawdult/`)

- `bin/` - Executable scripts (kill-switch, audit-wrapper)
- `config/` - Agent configuration (agent.env, agent.yaml)
- `logs/` - Agent, audit, and CLI logs
- `workspace/projects/` - Agent project directory
- `secrets/` - tmpfs mount (100MB, mode 0700) for API keys
- `tools/playwright/` - Playwright MCP configuration
- `openclaw/` - OpenClaw gateway data

### CloudWatch Log Groups

- `/clawdult/{instance-id}/agent` - Agent logs (30-day retention)
- `/clawdult/{instance-id}/audit` - Audit logs (90-day retention)
- `/clawdult/{instance-id}/cli` - CLI wrapper logs (30-day retention)
- `/clawdult/{instance-id}/os-audit` - Linux auditd logs (90-day retention)

## Security Architecture

**In-Memory Secrets**: `/opt/clawdult/secrets` is a tmpfs mount - secrets never touch disk.

**Permission Boundaries**: All agent IAM roles use `spending-limit-boundary.json` to prevent cost/security escalation.

**Instance Restrictions**: Only t3.micro-xlarge and m6i.large/xlarge allowed via IAM boundary.

**Audit Logging**: auditd monitors all access to secrets, configs, and SSH directories. All agent commands logged with execve syscall tracing.

**Network Controls**: Kill-switch can block all network except SSH at multiple severity levels.

**Region Restrictions**: Agents restricted to us-east-1/2, us-west-1/2, eu-west-1 via IAM.

## Technology Stack

- TypeScript with ESM modules (NodeNext)
- Commander.js for CLI, @inquirer/prompts for interactive UI
- Zod for schema validation
- Jest + ts-jest for testing
- Prettier for formatting
- Husky + lint-staged for pre-commit hooks
- AWS SDK v3 (clients for EC2, IAM, SSM, STS, Budgets)
- Packer + Ansible for AMI building
- keytar for secure credential storage (with AES-256-GCM file fallback)
- cosmiconfig for config file discovery

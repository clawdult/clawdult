# Clawdult: AI For the Professional Lobster

**Secure workstations for AI agents, provisioned in minutes.**

Deploy dedicated EC2 instances as isolated environments for AI agents—complete with audit logging, permission boundaries, and multi-channel messaging. Think of it as giving your AI teammates their own secure machines to work from. Also assists in allocation of communication channels and tools as a team member rather than impersonating a human user (unless you want it to).

<img width="196" height="292" alt="image" src="https://github.com/user-attachments/assets/c2047bc9-9466-451b-a06d-7d76484b63bc" />

## Philosophy

Agents should have real machines, not sandboxes, as well as resources and communication channels that treat them as separate autonomous entities. Real tools, real network access, real autonomy—within guardrails you control. Clawdult makes this safe and repeatable.

## Quick Start

```bash
# Install
./install.sh

# First-time AWS setup (creates IAM roles, builds AMI)
clawdult setup-admin

# Create a fully-configured workstation
clawdult create <optional-workstation-name>
```

Your agent now has its own workstation—reachable via Tailscale, Discord, Slack, or whichever channels you configured.

---

## How It Works

**AMI (pre-built)**: Contains all tools and services (Node, Docker, Claude CLI, Tailscale, OpenClaw)

**Create command**:

1. Gathers your profiles (API keys, GitHub account, connectivity)
2. Pushes secrets to AWS SSM
3. Launches EC2 instance with the Clawdult AMI
4. Waits for instance to pull secrets and configure services
5. Confirms when ready - agent is now reachable via messaging

## Commands

### Core Commands

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `create [name]`  | Provision and configure a new workstation              |
| `destroy [name]` | Terminate workstation and clean up resources           |
| `list`           | List all workstations (queries all regions by default) |
| `status [name]`  | Show detailed status of one or all workstations        |
| `ssh [name]`     | SSH into workstation (prefers Tailscale IP)            |
| `logs [name]`    | View agent, audit, or CLI logs                         |
| `cp [name]`      | Copy files to/from workstation                         |
| `gateway [name]` | Get OpenClaw gateway connection info                   |

### Setup & Config

| Command                        | Description                                      |
| ------------------------------ | ------------------------------------------------ |
| `setup-admin`                  | Bootstrap AWS credentials, IAM, budgets, and AMI |
| `config`                       | View and modify global settings                  |
| `completion install/uninstall` | Manage shell tab completions (bash/zsh/fish)     |

### Profiles

| Command                         | Description                                            |
| ------------------------------- | ------------------------------------------------------ |
| `profiles keys`                 | Manage API key profiles (Claude, OpenAI, Grok, Gemini) |
| `profiles budget`               | Manage AWS spending limit profiles                     |
| `profiles connectivity`         | Manage Tailscale and messaging channel profiles        |
| `secrets openclaw-token <name>` | Retrieve OpenClaw gateway token for a workstation      |

## Profile Management

Clawdult uses profiles to organize credentials and settings that can be reused across workstations.

### Key Profiles

Store API keys for AI services securely in your system keychain:

```bash
clawdult profiles keys create my-keys     # Create new profile
clawdult profiles keys list               # List all profiles
clawdult profiles keys edit my-keys       # Update keys
clawdult profiles keys delete my-keys     # Remove profile
```

Supported services: Claude (API key or setup token), OpenAI, Grok (xAI), Gemini (Google)

### Budget Profiles

Configure AWS spending limits with email notifications:

```bash
clawdult profiles budget create my-budget  # Create budget profile
clawdult profiles budget apply my-budget   # Apply to AWS Budgets
clawdult profiles budget status            # View current spend
```

Default alert thresholds: 50%, 80%, 100% of monthly limit.

### Connectivity Profiles

Configure Tailscale VPN and messaging channel integrations:

```bash
clawdult profiles connectivity create my-conn  # Create profile
clawdult profiles connectivity list            # List profiles
```

Supported channels: Discord, Slack, Telegram, Google Chat, Teams, Matrix, WebChat, BlueBubbles, Zalo

---

## Architecture

```
CLI (your machine)          AWS
┌─────────────────┐        ┌─────────────────────────────────────┐
│ clawdult create │───────>│ SSM Parameter Store (secrets)       │
│                 │        │ EC2 Instance (Clawdult AMI)         │
│ ~/.clawdult/    │        │   ├── OpenClaw gateway (messaging)  │
│   config.yaml   │        │   ├── Claude Code CLI               │
│   key-profiles/ │        │   ├── Tailscale VPN                 │
│   budget-profs/ │        │   └── Audit logging → CloudWatch    │
│   conn-profiles/│        │ IAM Role (permission boundary)      │
└─────────────────┘        └─────────────────────────────────────┘
```

**Each workstation comes with:**

- Node.js 22, Python 3.12, Go 1.22, Rust
- Docker with log rotation
- Claude Code and OpenAI Codex CLIs (with audit wrappers)
- GitHub CLI and AWS CLI v2
- Tailscale VPN client
- OpenClaw gateway (messaging channels)
- Playwright MCP server (browser automation)
- auditd + CloudWatch agent (comprehensive logging)

---

## Security

**Permission Boundaries**: All agent IAM roles include a permission boundary that prevents:

- Launching expensive instance types (only t3.micro-xlarge, m6i.large/xlarge allowed)
- IAM privilege escalation (no creating users, roles, or policies)
- Account/billing modifications
- Operations outside allowed regions (us-east-1/2, us-west-1/2, eu-west-1)

**In-Memory Secrets**: API keys are stored in a tmpfs mount (`/opt/clawdult/secrets`) that never touches disk.

**Audit Logging**: All agent activity is logged via auditd and shipped to CloudWatch:

- Command execution (execve syscall tracing)
- Access to secrets, configs, and SSH directories
- Log retention: 30 days (agent/CLI), 90 days (audit)

**Kill Switch**: Four-level emergency shutdown capability:

| Level     | Action                                              |
| --------- | --------------------------------------------------- |
| Soft      | Graceful process termination                        |
| Hard      | Force kill, revoke tokens, block network (SSH only) |
| Emergency | Stop instance                                       |
| Nuclear   | Snapshot for forensics, then terminate              |

## Configuration

Config file: `~/.clawdult/config.yaml`

```bash
# View current configuration
clawdult config --list

# Set defaults
clawdult config --set defaultRegion=us-west-2
clawdult config --set defaultInstanceType=t3.large
clawdult config --set defaultVolumeSize=100

# Reset to defaults
clawdult config --reset
```

**Available settings:**

| Setting               | Description                     | Default            |
| --------------------- | ------------------------------- | ------------------ |
| `defaultRegion`       | AWS region for new workstations | `us-east-1`        |
| `defaultInstanceType` | EC2 instance type               | `t3.medium`        |
| `defaultVolumeSize`   | EBS volume size in GB (20-500)  | `50`               |
| `sshKeyPath`          | Path to SSH private key         | -                  |
| `sshKeyName`          | EC2 key pair name               | -                  |
| `awsProfile`          | AWS CLI profile name            | -                  |
| `logsDirectory`       | CLI log directory               | `~/.clawdult/logs` |
| `allowedSshCidr`      | CIDR for SSH security group     | -                  |

---

## Development

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript + run tests
npm run dev       # Watch mode
npm run lint      # Run ESLint
npm run format    # Format with Prettier
npm test          # Run Jest tests
npm link          # Link for local testing
```

## Building the AMI

```bash
cd packer
packer build clawdult-ami.pkr.hcl
```

The AMI build uses Ansible roles to install and configure all workstation components. Build takes 10-15 minutes.

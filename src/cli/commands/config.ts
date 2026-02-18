import { Command } from 'commander';
// prompts imported for future interactive config features
import chalk from 'chalk';
import { loadGlobalConfig, saveGlobalConfig, getConfigDir } from '../../services/config.js';
import { InstanceTypeSchema, RegionSchema, GlobalConfig } from '../../schemas/config.js';
import { CLIError } from '../utils/errors.js';

export const configCommand = new Command('config')
  .description('Manage CLI configuration')
  .option('-l, --list', 'List current configuration')
  .option('-s, --set <key=value>', 'Set a configuration value')
  .option('-g, --get <key>', 'Get a configuration value')
  .option('--reset', 'Reset configuration to defaults')
  .action(async (options) => {
    const config = await loadGlobalConfig();

    // List mode
    if (options.list || (!options.set && !options.get && !options.reset)) {
      console.log(chalk.bold('\n⚙️  Clawdult Configuration\n'));
      console.log(chalk.dim(`Config directory: ${getConfigDir()}\n`));
      console.log(`  defaultRegion:       ${chalk.cyan(config.defaultRegion)}`);
      console.log(`  defaultInstanceType: ${chalk.cyan(config.defaultInstanceType)}`);
      console.log(`  defaultVolumeSize:   ${chalk.cyan(config.defaultVolumeSize)} GB`);
      console.log(`  sshKeyPath:          ${chalk.cyan(config.sshKeyPath || '(not set)')}`);
      console.log(`  sshKeyName:          ${chalk.cyan(config.sshKeyName || '(not set)')}`);
      console.log(`  awsProfile:          ${chalk.cyan(config.awsProfile || '(default)')}`);
      console.log(`  logsDirectory:       ${chalk.cyan(config.logsDirectory)}`);
      console.log(`  allowedSshCidr:      ${chalk.cyan(config.allowedSshCidr || '(not set)')}`);
      console.log('');

      if (!options.list) {
        console.log(chalk.dim('Use --set key=value to change settings.'));
        console.log(chalk.dim('Example: clawdult config --set defaultRegion=us-west-2\n'));
      }
      return;
    }

    // Get mode
    if (options.get) {
      const key = options.get as keyof GlobalConfig;
      if (key in config) {
        console.log(config[key]);
      } else {
        throw new CLIError(`Unknown config key: ${key}`);
      }
      return;
    }

    // Set mode
    if (options.set) {
      const [key, ...valueParts] = options.set.split('=');
      const value = valueParts.join('=');

      if (!key || value === undefined) {
        throw new CLIError('Invalid format. Use: --set key=value');
      }

      const updatedConfig = { ...config };

      switch (key) {
        case 'defaultRegion': {
          const result = RegionSchema.safeParse(value);
          if (!result.success) {
            throw new CLIError(`Invalid region. Valid options: ${RegionSchema.options.join(', ')}`);
          }
          updatedConfig.defaultRegion = result.data;
          break;
        }
        case 'defaultInstanceType': {
          const result = InstanceTypeSchema.safeParse(value);
          if (!result.success) {
            throw new CLIError(
              `Invalid instance type. Valid options: ${InstanceTypeSchema.options.join(', ')}`
            );
          }
          updatedConfig.defaultInstanceType = result.data;
          break;
        }
        case 'defaultVolumeSize': {
          const size = parseInt(value);
          if (isNaN(size) || size < 20 || size > 500) {
            throw new CLIError('Volume size must be between 20 and 500 GB');
          }
          updatedConfig.defaultVolumeSize = size;
          break;
        }
        case 'sshKeyPath':
          updatedConfig.sshKeyPath = value || undefined;
          break;
        case 'sshKeyName':
          updatedConfig.sshKeyName = value || undefined;
          break;
        case 'awsProfile':
          updatedConfig.awsProfile = value || undefined;
          break;
        case 'logsDirectory':
          updatedConfig.logsDirectory = value;
          break;
        case 'allowedSshCidr': {
          if (value && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(value)) {
            throw new CLIError('Invalid CIDR format (e.g., 1.2.3.4/32)');
          }
          updatedConfig.allowedSshCidr = value || undefined;
          break;
        }
        default:
          throw new CLIError(
            `Unknown config key: ${key}\nValid keys: defaultRegion, defaultInstanceType, defaultVolumeSize, sshKeyPath, sshKeyName, awsProfile, logsDirectory, allowedSshCidr`
          );
      }

      await saveGlobalConfig(updatedConfig);
      console.log(chalk.green(`✓ Set ${key} = ${value}`));
      return;
    }

    // Reset mode
    if (options.reset) {
      const defaultConfig = {
        defaultRegion: 'us-east-1' as const,
        defaultInstanceType: 't3.medium' as const,
        defaultVolumeSize: 50,
        logsDirectory: '~/.clawdult/logs',
        sshKeyPaths: {},
        budgetMonthlyLimit: 1000,
        budgetAlertThresholds: [50, 80, 100] as number[],
        githubAgentAccounts: [],
      };

      await saveGlobalConfig(defaultConfig);
      console.log(chalk.green('✓ Configuration reset to defaults'));
    }
  });

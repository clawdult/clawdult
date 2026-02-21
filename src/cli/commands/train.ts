import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadGlobalConfig } from '../../services/config.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import {
  listTrainingJobs,
  getTrainingJobStatus,
  stopTrainingJob,
} from '../../services/sagemaker.js';
import { CLIError } from '../utils/errors.js';

function formatJobStatus(status: string): string {
  switch (status) {
    case 'Completed':
      return chalk.green(status);
    case 'InProgress':
      return chalk.cyan(status);
    case 'Failed':
      return chalk.red(status);
    case 'Stopping':
    case 'Stopped':
      return chalk.yellow(status);
    default:
      return chalk.dim(status);
  }
}

function formatDuration(startTime?: Date, endTime?: Date): string {
  if (!startTime) return '-';
  const end = endTime ?? new Date();
  const seconds = Math.floor((end.getTime() - startTime.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

const listSubcommand = new Command('list')
  .description('List training jobs')
  .argument('[agent]', 'Filter by agent name')
  .option('-r, --region <region>', 'AWS region')
  .option('-j, --json', 'Output as JSON')
  .action(async (agent: string | undefined, options) => {
    await requireAwsCredentials();
    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    const spinner = ora('Fetching training jobs...').start();
    const jobs = await listTrainingJobs(region, agent);
    spinner.stop();

    if (jobs.length === 0) {
      console.log(chalk.yellow('\nNo training jobs found.\n'));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }

    console.log(chalk.bold('\nTraining Jobs\n'));
    console.log(
      chalk.dim('  ') +
        chalk.dim('JOB NAME'.padEnd(45)) +
        chalk.dim('STATUS'.padEnd(16)) +
        chalk.dim('DURATION'.padEnd(12)) +
        chalk.dim('CREATED')
    );
    console.log(chalk.dim('  ' + '─'.repeat(90)));

    for (const job of jobs) {
      const created = job.CreationTime
        ? job.CreationTime.toISOString().replace('T', ' ').slice(0, 19)
        : '-';
      const duration = formatDuration(job.CreationTime, job.TrainingEndTime);
      console.log(
        '  ' +
          (job.TrainingJobName ?? '-').padEnd(45) +
          formatJobStatus(job.TrainingJobStatus ?? 'Unknown').padEnd(16 + 10) +
          duration.padEnd(12) +
          created
      );
    }
    console.log('');
  });

const statusSubcommand = new Command('status')
  .description('Show detailed training job status')
  .argument('<agent>', 'Agent name')
  .argument('[job]', 'Specific job name (shows latest if omitted)')
  .option('-r, --region <region>', 'AWS region')
  .option('-j, --json', 'Output as JSON')
  .action(async (agent: string, job: string | undefined, options) => {
    await requireAwsCredentials();
    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    let jobName = job;
    if (!jobName) {
      // Find the latest job for this agent
      const jobs = await listTrainingJobs(region, agent);
      if (jobs.length === 0) {
        throw new CLIError(`No training jobs found for agent '${agent}'`);
      }
      jobName = jobs[0].TrainingJobName!;
    }

    const spinner = ora(`Fetching status for ${jobName}...`).start();
    const info = await getTrainingJobStatus(jobName, region);
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }

    console.log(chalk.bold(`\nTraining Job: ${info.jobName}\n`));
    console.log(`  Status:          ${formatJobStatus(info.status)}`);
    if (info.secondaryStatus) {
      console.log(`  Secondary:       ${chalk.dim(info.secondaryStatus)}`);
    }
    console.log(`  Instance Type:   ${chalk.dim(info.instanceType ?? '-')}`);
    console.log(`  Created:         ${chalk.dim(info.creationTime?.toISOString() ?? '-')}`);
    if (info.trainingStartTime) {
      console.log(`  Started:         ${chalk.dim(info.trainingStartTime.toISOString())}`);
    }
    if (info.trainingEndTime) {
      console.log(`  Ended:           ${chalk.dim(info.trainingEndTime.toISOString())}`);
    }
    console.log(
      `  Duration:        ${chalk.dim(formatDuration(info.trainingStartTime, info.trainingEndTime))}`
    );
    if (info.billableTimeSeconds != null) {
      console.log(`  Billable Time:   ${chalk.dim(`${info.billableTimeSeconds}s`)}`);
    }
    if (info.failureReason) {
      console.log(`  Failure Reason:  ${chalk.red(info.failureReason)}`);
    }
    console.log(`  ARN:             ${chalk.dim(info.jobArn)}`);
    console.log('');
  });

const stopSubcommand = new Command('stop')
  .description('Stop a running training job')
  .argument('<job-name>', 'Training job name to stop')
  .option('-r, --region <region>', 'AWS region')
  .action(async (jobName: string, options) => {
    await requireAwsCredentials();
    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    // Verify the job exists and is running
    const info = await getTrainingJobStatus(jobName, region);
    if (info.status !== 'InProgress') {
      throw new CLIError(`Job '${jobName}' is not running (current status: ${info.status})`);
    }

    const spinner = ora(`Stopping training job ${jobName}...`).start();
    await stopTrainingJob(jobName, region);
    spinner.succeed(`Stop requested for ${jobName}`);
    console.log(chalk.dim('  Job will transition to Stopping → Stopped\n'));
  });

const logsSubcommand = new Command('logs')
  .description('View training job logs from CloudWatch')
  .argument('<job-name>', 'Training job name')
  .option('-r, --region <region>', 'AWS region')
  .action(async (jobName: string, options) => {
    await requireAwsCredentials();
    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    // SageMaker logs go to /aws/sagemaker/TrainingJobs
    const logGroup = '/aws/sagemaker/TrainingJobs';
    const logStream = jobName + '/algo-1-*';

    console.log(chalk.bold(`\nTraining Logs: ${jobName}\n`));
    console.log(chalk.dim(`  Log Group:  ${logGroup}`));
    console.log(chalk.dim(`  Stream:     ${logStream}\n`));
    console.log(
      chalk.cyan(
        `  View in console: https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(logGroup)}`
      )
    );
    console.log(
      chalk.dim(
        `\n  Or use AWS CLI:\n  aws logs filter-log-events --log-group-name "${logGroup}" --log-stream-name-prefix "${jobName}/algo-1" --region ${region}\n`
      )
    );
  });

export const trainCommand = new Command('train')
  .description('Manage GPU training jobs dispatched by agents via SageMaker')
  .addCommand(listSubcommand)
  .addCommand(statusSubcommand)
  .addCommand(stopSubcommand)
  .addCommand(logsSubcommand);

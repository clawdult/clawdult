import {
  SageMakerClient,
  CreateTrainingJobCommand,
  DescribeTrainingJobCommand,
  StopTrainingJobCommand,
  ListTrainingJobsCommand,
  CreateExperimentCommand,
  CreateTrialCommand,
  CreateTrialComponentCommand,
  UpdateTrialComponentCommand,
  type TrainingInstanceType,
  type TrainingJobSummary,
} from '@aws-sdk/client-sagemaker';
import { getAWSClientConfig } from './aws-client.js';

async function createSageMakerClient(region: string): Promise<SageMakerClient> {
  return new SageMakerClient(await getAWSClientConfig(region));
}

export interface TrainingJobParams {
  /** Docker image URI (e.g., SageMaker pre-built PyTorch/HuggingFace image) */
  imageUri: string;
  /** SageMaker instance type (ml.g4dn.xlarge, ml.p3.2xlarge, etc.) */
  instanceType: string;
  /** Number of training instances */
  instanceCount?: number;
  /** Volume size in GB */
  volumeSizeGB?: number;
  /** S3 URI for training data input */
  inputDataUri: string;
  /** S3 URI for model output */
  outputDataUri: string;
  /** Hyperparameters passed to training script */
  hyperparameters?: Record<string, string>;
  /** Use spot instances for cost savings */
  useSpotInstances?: boolean;
  /** Max seconds to wait for spot capacity */
  maxSpotWaitSeconds?: number;
  /** Max runtime in seconds */
  maxRuntimeSeconds?: number;
  /** Optional experiment name to associate with */
  experimentName?: string;
  /** Optional trial name to associate with */
  trialName?: string;
}

export interface TrainingJobInfo {
  jobName: string;
  jobArn: string;
  status: string;
  secondaryStatus?: string;
  creationTime?: Date;
  trainingStartTime?: Date;
  trainingEndTime?: Date;
  instanceType?: string;
  failureReason?: string;
  billableTimeSeconds?: number;
}

/**
 * Submit a SageMaker training job. Job name follows clawdult-{agentName}-{timestamp} convention.
 */
export async function submitTrainingJob(
  agentName: string,
  region: string,
  sageMakerRoleArn: string,
  params: TrainingJobParams
): Promise<{ jobName: string; jobArn: string }> {
  const client = await createSageMakerClient(region);
  const timestamp = Date.now();
  const jobName = `clawdult-${agentName}-${timestamp}`;

  const tags = [
    { Key: 'clawdult:managed', Value: 'true' },
    { Key: 'clawdult:agent', Value: agentName },
  ];

  const stoppingCondition: Record<string, number> = {
    MaxRuntimeInSeconds: params.maxRuntimeSeconds ?? 86400,
  };
  if (params.useSpotInstances) {
    stoppingCondition.MaxWaitTimeInSeconds = params.maxSpotWaitSeconds ?? 3600;
  }

  const experimentConfig =
    params.experimentName || params.trialName
      ? {
          ExperimentName: params.experimentName,
          TrialName: params.trialName,
          TrialComponentDisplayName: jobName,
        }
      : undefined;

  const response = await client.send(
    new CreateTrainingJobCommand({
      TrainingJobName: jobName,
      RoleArn: sageMakerRoleArn,
      AlgorithmSpecification: {
        TrainingImage: params.imageUri,
        TrainingInputMode: 'File',
      },
      InputDataConfig: [
        {
          ChannelName: 'training',
          DataSource: {
            S3DataSource: {
              S3DataType: 'S3Prefix',
              S3Uri: params.inputDataUri,
              S3DataDistributionType: 'FullyReplicated',
            },
          },
        },
      ],
      OutputDataConfig: {
        S3OutputPath: params.outputDataUri,
      },
      ResourceConfig: {
        InstanceType: params.instanceType as TrainingInstanceType,
        InstanceCount: params.instanceCount ?? 1,
        VolumeSizeInGB: params.volumeSizeGB ?? 50,
      },
      StoppingCondition: stoppingCondition,
      EnableManagedSpotTraining: params.useSpotInstances ?? true,
      HyperParameters: params.hyperparameters,
      ExperimentConfig: experimentConfig,
      Tags: tags,
    })
  );

  return { jobName, jobArn: response.TrainingJobArn! };
}

/**
 * Get detailed status of a training job.
 */
export async function getTrainingJobStatus(
  jobName: string,
  region: string
): Promise<TrainingJobInfo> {
  const client = await createSageMakerClient(region);
  const response = await client.send(new DescribeTrainingJobCommand({ TrainingJobName: jobName }));

  return {
    jobName: response.TrainingJobName!,
    jobArn: response.TrainingJobArn!,
    status: response.TrainingJobStatus!,
    secondaryStatus: response.SecondaryStatus,
    creationTime: response.CreationTime,
    trainingStartTime: response.TrainingStartTime,
    trainingEndTime: response.TrainingEndTime,
    instanceType: response.ResourceConfig?.InstanceType,
    failureReason: response.FailureReason,
    billableTimeSeconds: response.BillableTimeInSeconds,
  };
}

/**
 * Stop a running training job.
 */
export async function stopTrainingJob(jobName: string, region: string): Promise<void> {
  const client = await createSageMakerClient(region);
  await client.send(new StopTrainingJobCommand({ TrainingJobName: jobName }));
}

/**
 * List training jobs for an agent (filtered by clawdult-{agentName} prefix).
 */
export async function listTrainingJobs(
  region: string,
  agentName?: string
): Promise<TrainingJobSummary[]> {
  const client = await createSageMakerClient(region);
  const nameContains = agentName ? `clawdult-${agentName}` : 'clawdult-';

  const response = await client.send(
    new ListTrainingJobsCommand({
      NameContains: nameContains,
      SortBy: 'CreationTime',
      SortOrder: 'Descending',
      MaxResults: 50,
    })
  );

  return response.TrainingJobSummaries ?? [];
}

/**
 * Create a SageMaker Experiment for organizing training runs.
 */
export async function createExperiment(
  agentName: string,
  region: string,
  experimentSuffix: string,
  description?: string
): Promise<string> {
  const client = await createSageMakerClient(region);
  const experimentName = `clawdult-${agentName}-${experimentSuffix}`;

  const response = await client.send(
    new CreateExperimentCommand({
      ExperimentName: experimentName,
      Description: description,
      Tags: [
        { Key: 'clawdult:managed', Value: 'true' },
        { Key: 'clawdult:agent', Value: agentName },
      ],
    })
  );

  return response.ExperimentArn!;
}

/**
 * Create a trial within an experiment.
 */
export async function createTrial(
  experimentName: string,
  trialSuffix: string,
  region: string
): Promise<string> {
  const client = await createSageMakerClient(region);
  const trialName = `${experimentName}-${trialSuffix}`;

  const response = await client.send(
    new CreateTrialCommand({
      TrialName: trialName,
      ExperimentName: experimentName,
    })
  );

  return response.TrialArn!;
}

/**
 * Log metrics to a trial component.
 */
export async function logMetrics(
  trialComponentName: string,
  region: string,
  metrics: Record<string, number>,
  parameters?: Record<string, string>
): Promise<void> {
  const client = await createSageMakerClient(region);

  // Try to create the trial component first; update if it already exists
  try {
    await client.send(
      new CreateTrialComponentCommand({
        TrialComponentName: trialComponentName,
        Parameters: parameters
          ? Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { StringValue: v }]))
          : undefined,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ConflictException')) {
      throw error;
    }
  }

  await client.send(
    new UpdateTrialComponentCommand({
      TrialComponentName: trialComponentName,
      OutputArtifacts: Object.fromEntries(
        Object.entries(metrics).map(([k, v]) => [k, { Value: String(v) }])
      ),
    })
  );
}

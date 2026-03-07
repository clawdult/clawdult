import { jest } from '@jest/globals';

// --- Mocks ---

const mockSend = jest.fn<(cmd: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-sagemaker', () => {
  class FakeSageMakerClient {
    send = mockSend;
  }

  const cmd = (name: string) =>
    class {
      static _name = name;
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    };

  return {
    SageMakerClient: FakeSageMakerClient,
    CreateTrainingJobCommand: cmd('CreateTrainingJobCommand'),
    DescribeTrainingJobCommand: cmd('DescribeTrainingJobCommand'),
    StopTrainingJobCommand: cmd('StopTrainingJobCommand'),
    ListTrainingJobsCommand: cmd('ListTrainingJobsCommand'),
    CreateExperimentCommand: cmd('CreateExperimentCommand'),
    CreateTrialCommand: cmd('CreateTrialCommand'),
    CreateTrialComponentCommand: cmd('CreateTrialComponentCommand'),
    UpdateTrialComponentCommand: cmd('UpdateTrialComponentCommand'),
  };
});

jest.unstable_mockModule('./aws-client.js', () => ({
  getAWSClientConfig: jest
    .fn<() => Promise<{ region: string }>>()
    .mockResolvedValue({ region: 'us-east-1' }),
}));

const {
  submitTrainingJob,
  getTrainingJobStatus,
  stopTrainingJob,
  listTrainingJobs,
  createExperiment,
  createTrial,
  logMetrics,
} = await import('./sagemaker.js');

// --- Tests ---

describe('submitTrainingJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({
      TrainingJobArn: 'arn:aws:sagemaker:us-east-1:123:training-job/test',
    });
  });

  it('uses clawdult-{agent}-{timestamp} naming convention', async () => {
    const before = Date.now();
    const result = await submitTrainingJob('my-agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
    });

    expect(result.jobName).toMatch(/^clawdult-my-agent-\d+$/);
    const timestamp = parseInt(result.jobName.split('-').pop()!);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('returns jobName and jobArn', async () => {
    const result = await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
    });

    expect(result.jobArn).toBe('arn:aws:sagemaker:us-east-1:123:training-job/test');
    expect(result.jobName).toMatch(/^clawdult-agent-/);
  });

  it('maps params correctly to CreateTrainingJobCommand', async () => {
    await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'my-image:v1',
      instanceType: 'ml.p3.2xlarge',
      instanceCount: 2,
      volumeSizeGB: 100,
      inputDataUri: 's3://data/train',
      outputDataUri: 's3://data/output',
      hyperparameters: { lr: '0.001' },
      maxRuntimeSeconds: 7200,
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.RoleArn).toBe('arn:role');
    expect(input.AlgorithmSpecification).toEqual({
      TrainingImage: 'my-image:v1',
      TrainingInputMode: 'File',
    });
    expect(input.ResourceConfig).toEqual({
      InstanceType: 'ml.p3.2xlarge',
      InstanceCount: 2,
      VolumeSizeInGB: 100,
    });
    expect(input.OutputDataConfig).toEqual({ S3OutputPath: 's3://data/output' });
    expect(input.HyperParameters).toEqual({ lr: '0.001' });
    expect((input.StoppingCondition as Record<string, number>).MaxRuntimeInSeconds).toBe(7200);
  });

  it('uses default instanceCount=1 and volumeSizeGB=50', async () => {
    await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect((input.ResourceConfig as Record<string, unknown>).InstanceCount).toBe(1);
    expect((input.ResourceConfig as Record<string, unknown>).VolumeSizeInGB).toBe(50);
  });

  it('sets MaxWaitTimeInSeconds when useSpotInstances is true', async () => {
    await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
      useSpotInstances: true,
      maxSpotWaitSeconds: 1800,
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    const stoppingCondition = input.StoppingCondition as Record<string, number>;
    expect(stoppingCondition.MaxWaitTimeInSeconds).toBe(1800);
    expect(input.EnableManagedSpotTraining).toBe(true);
  });

  it('defaults maxSpotWaitSeconds to 3600 when useSpotInstances is true', async () => {
    await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
      useSpotInstances: true,
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    const stoppingCondition = input.StoppingCondition as Record<string, number>;
    expect(stoppingCondition.MaxWaitTimeInSeconds).toBe(3600);
  });

  it('does not set MaxWaitTimeInSeconds when useSpotInstances is not set', async () => {
    await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    const stoppingCondition = input.StoppingCondition as Record<string, number>;
    expect(stoppingCondition.MaxWaitTimeInSeconds).toBeUndefined();
  });

  it('includes clawdult tags', async () => {
    await submitTrainingJob('my-agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.Tags).toEqual([
      { Key: 'clawdult:managed', Value: 'true' },
      { Key: 'clawdult:agent', Value: 'my-agent' },
    ]);
  });

  it('includes experimentConfig when experimentName is set', async () => {
    await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
      experimentName: 'my-experiment',
      trialName: 'my-trial',
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    const experimentConfig = input.ExperimentConfig as Record<string, string>;
    expect(experimentConfig.ExperimentName).toBe('my-experiment');
    expect(experimentConfig.TrialName).toBe('my-trial');
    expect(experimentConfig.TrialComponentDisplayName).toMatch(/^clawdult-agent-/);
  });

  it('omits experimentConfig when neither experimentName nor trialName is set', async () => {
    await submitTrainingJob('agent', 'us-east-1', 'arn:role', {
      imageUri: 'image:latest',
      instanceType: 'ml.g4dn.xlarge',
      inputDataUri: 's3://bucket/input',
      outputDataUri: 's3://bucket/output',
    });

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.ExperimentConfig).toBeUndefined();
  });
});

describe('getTrainingJobStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps response fields correctly to TrainingJobInfo', async () => {
    const creationTime = new Date('2025-01-01');
    const startTime = new Date('2025-01-01T00:05:00');
    const endTime = new Date('2025-01-01T01:00:00');

    mockSend.mockResolvedValueOnce({
      TrainingJobName: 'clawdult-agent-123',
      TrainingJobArn: 'arn:aws:sagemaker:us-east-1:123:training-job/clawdult-agent-123',
      TrainingJobStatus: 'Completed',
      SecondaryStatus: 'Completed',
      CreationTime: creationTime,
      TrainingStartTime: startTime,
      TrainingEndTime: endTime,
      ResourceConfig: { InstanceType: 'ml.g4dn.xlarge' },
      FailureReason: undefined,
      BillableTimeInSeconds: 3300,
    });

    const info = await getTrainingJobStatus('clawdult-agent-123', 'us-east-1');

    expect(info).toEqual({
      jobName: 'clawdult-agent-123',
      jobArn: 'arn:aws:sagemaker:us-east-1:123:training-job/clawdult-agent-123',
      status: 'Completed',
      secondaryStatus: 'Completed',
      creationTime,
      trainingStartTime: startTime,
      trainingEndTime: endTime,
      instanceType: 'ml.g4dn.xlarge',
      failureReason: undefined,
      billableTimeSeconds: 3300,
    });
  });

  it('sends DescribeTrainingJobCommand with correct job name', async () => {
    mockSend.mockResolvedValueOnce({
      TrainingJobName: 'job-1',
      TrainingJobArn: 'arn:job-1',
      TrainingJobStatus: 'InProgress',
    });

    await getTrainingJobStatus('job-1', 'us-east-1');

    const input = (mockSend.mock.calls[0][0] as { input: { TrainingJobName: string } }).input;
    expect(input.TrainingJobName).toBe('job-1');
  });
});

describe('stopTrainingJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('sends StopTrainingJobCommand with correct job name', async () => {
    await stopTrainingJob('clawdult-agent-123', 'us-east-1');

    const input = (mockSend.mock.calls[0][0] as { input: { TrainingJobName: string } }).input;
    expect(input.TrainingJobName).toBe('clawdult-agent-123');
  });
});

describe('listTrainingJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses clawdult-{agentName} prefix when agent specified', async () => {
    mockSend.mockResolvedValueOnce({ TrainingJobSummaries: [] });

    await listTrainingJobs('us-east-1', 'my-agent');

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.NameContains).toBe('clawdult-my-agent');
  });

  it('uses clawdult- prefix when no agent specified', async () => {
    mockSend.mockResolvedValueOnce({ TrainingJobSummaries: [] });

    await listTrainingJobs('us-east-1');

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.NameContains).toBe('clawdult-');
  });

  it('sets SortBy, SortOrder, and MaxResults', async () => {
    mockSend.mockResolvedValueOnce({ TrainingJobSummaries: [] });

    await listTrainingJobs('us-east-1');

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.SortBy).toBe('CreationTime');
    expect(input.SortOrder).toBe('Descending');
    expect(input.MaxResults).toBe(50);
  });

  it('returns TrainingJobSummaries from response', async () => {
    const summaries = [
      { TrainingJobName: 'job-1', TrainingJobStatus: 'Completed' },
      { TrainingJobName: 'job-2', TrainingJobStatus: 'InProgress' },
    ];
    mockSend.mockResolvedValueOnce({ TrainingJobSummaries: summaries });

    const result = await listTrainingJobs('us-east-1', 'agent');
    expect(result).toEqual(summaries);
  });

  it('returns empty array when TrainingJobSummaries is undefined', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await listTrainingJobs('us-east-1');
    expect(result).toEqual([]);
  });
});

describe('createExperiment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses clawdult-{agent}-{suffix} naming', async () => {
    mockSend.mockResolvedValueOnce({ ExperimentArn: 'arn:experiment' });

    await createExperiment('my-agent', 'us-east-1', 'fine-tune-v1', 'Test experiment');

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.ExperimentName).toBe('clawdult-my-agent-fine-tune-v1');
    expect(input.Description).toBe('Test experiment');
  });

  it('includes clawdult tags', async () => {
    mockSend.mockResolvedValueOnce({ ExperimentArn: 'arn:experiment' });

    await createExperiment('my-agent', 'us-east-1', 'exp');

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.Tags).toEqual([
      { Key: 'clawdult:managed', Value: 'true' },
      { Key: 'clawdult:agent', Value: 'my-agent' },
    ]);
  });

  it('returns ExperimentArn', async () => {
    mockSend.mockResolvedValueOnce({
      ExperimentArn: 'arn:aws:sagemaker:us-east-1:123:experiment/exp',
    });

    const arn = await createExperiment('agent', 'us-east-1', 'exp');
    expect(arn).toBe('arn:aws:sagemaker:us-east-1:123:experiment/exp');
  });
});

describe('createTrial', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses {experimentName}-{suffix} naming', async () => {
    mockSend.mockResolvedValueOnce({ TrialArn: 'arn:trial' });

    await createTrial('clawdult-agent-exp', 'run-1', 'us-east-1');

    const input = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.TrialName).toBe('clawdult-agent-exp-run-1');
    expect(input.ExperimentName).toBe('clawdult-agent-exp');
  });

  it('returns TrialArn', async () => {
    mockSend.mockResolvedValueOnce({ TrialArn: 'arn:aws:sagemaker:us-east-1:123:trial/t' });

    const arn = await createTrial('exp', 'run-1', 'us-east-1');
    expect(arn).toBe('arn:aws:sagemaker:us-east-1:123:trial/t');
  });
});

describe('logMetrics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates trial component first, then updates with metrics', async () => {
    mockSend.mockResolvedValue({});

    await logMetrics('my-component', 'us-east-1', { accuracy: 0.95, loss: 0.05 }, { lr: '0.001' });

    expect(mockSend).toHaveBeenCalledTimes(2);

    // First call: CreateTrialComponentCommand
    const createInput = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(createInput.TrialComponentName).toBe('my-component');
    expect(createInput.Parameters).toEqual({ lr: { StringValue: '0.001' } });

    // Second call: UpdateTrialComponentCommand
    const updateInput = (mockSend.mock.calls[1][0] as { input: Record<string, unknown> }).input;
    expect(updateInput.TrialComponentName).toBe('my-component');
    expect(updateInput.OutputArtifacts).toEqual({
      accuracy: { Value: '0.95' },
      loss: { Value: '0.05' },
    });
  });

  it('handles ConflictException on create by falling through to update', async () => {
    const conflictError = new Error('Already exists');
    conflictError.name = 'ConflictException';
    mockSend.mockRejectedValueOnce(conflictError).mockResolvedValueOnce({});

    await logMetrics('existing-component', 'us-east-1', { accuracy: 0.9 });

    expect(mockSend).toHaveBeenCalledTimes(2);
    // Update should still be called
    const updateInput = (mockSend.mock.calls[1][0] as { input: Record<string, unknown> }).input;
    expect(updateInput.TrialComponentName).toBe('existing-component');
    expect(updateInput.OutputArtifacts).toEqual({ accuracy: { Value: '0.9' } });
  });

  it('propagates non-ConflictException errors', async () => {
    const error = new Error('Access denied');
    error.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(error);

    await expect(logMetrics('comp', 'us-east-1', { x: 1 })).rejects.toThrow('Access denied');
    // Update should not be called
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('omits Parameters when not provided', async () => {
    mockSend.mockResolvedValue({});

    await logMetrics('comp', 'us-east-1', { loss: 0.1 });

    const createInput = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(createInput.Parameters).toBeUndefined();
  });
});

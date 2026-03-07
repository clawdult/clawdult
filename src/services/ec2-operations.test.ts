import { jest } from '@jest/globals';

// --- Mocks ---

const mockEC2Send = jest.fn<(cmd: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-ec2', () => {
  class FakeEC2Client {
    send = mockEC2Send;
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
    EC2Client: FakeEC2Client,
    RunInstancesCommand: cmd('RunInstancesCommand'),
    DescribeInstancesCommand: cmd('DescribeInstancesCommand'),
    DescribeImagesCommand: cmd('DescribeImagesCommand'),
    TerminateInstancesCommand: cmd('TerminateInstancesCommand'),
    StopInstancesCommand: cmd('StopInstancesCommand'),
    StartInstancesCommand: cmd('StartInstancesCommand'),
    ModifyInstanceAttributeCommand: cmd('ModifyInstanceAttributeCommand'),
    CreateImageCommand: cmd('CreateImageCommand'),
    DeregisterImageCommand: cmd('DeregisterImageCommand'),
    CopyImageCommand: cmd('CopyImageCommand'),
    DescribeVpcsCommand: cmd('DescribeVpcsCommand'),
    DescribeSecurityGroupsCommand: cmd('DescribeSecurityGroupsCommand'),
    CreateSecurityGroupCommand: cmd('CreateSecurityGroupCommand'),
    AuthorizeSecurityGroupIngressCommand: cmd('AuthorizeSecurityGroupIngressCommand'),
    CreateKeyPairCommand: cmd('CreateKeyPairCommand'),
    DescribeKeyPairsCommand: cmd('DescribeKeyPairsCommand'),
    CreateTagsCommand: cmd('CreateTagsCommand'),
    DeleteTagsCommand: cmd('DeleteTagsCommand'),
  };
});

jest.unstable_mockModule('./aws-client.js', () => ({
  getAWSClientConfig: jest
    .fn<() => Promise<{ region: string }>>()
    .mockResolvedValue({ region: 'us-east-1' }),
}));

const {
  stopInstance,
  startInstance,
  modifyInstanceType,
  setInstanceTag,
  deleteInstanceTag,
  createAmiFromInstance,
  describeAmi,
  copyAmiToRegion,
  deregisterAmi,
} = await import('./ec2.js');

// --- Tests ---

describe('stopInstance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEC2Send.mockResolvedValue({});
  });

  it('sends StopInstancesCommand with correct InstanceIds', async () => {
    await stopInstance('i-abc123', 'us-east-1');

    const input = (mockEC2Send.mock.calls[0][0] as { input: { InstanceIds: string[] } }).input;
    expect(input.InstanceIds).toEqual(['i-abc123']);
  });

  it('propagates errors from EC2', async () => {
    mockEC2Send.mockRejectedValueOnce(new Error('Instance not found'));

    await expect(stopInstance('i-bad', 'us-east-1')).rejects.toThrow('Instance not found');
  });
});

describe('startInstance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEC2Send.mockResolvedValue({});
  });

  it('sends StartInstancesCommand with correct InstanceIds', async () => {
    await startInstance('i-abc123', 'us-east-1');

    const input = (mockEC2Send.mock.calls[0][0] as { input: { InstanceIds: string[] } }).input;
    expect(input.InstanceIds).toEqual(['i-abc123']);
  });

  it('propagates errors from EC2', async () => {
    mockEC2Send.mockRejectedValueOnce(new Error('Cannot start terminated instance'));

    await expect(startInstance('i-dead', 'us-east-1')).rejects.toThrow(
      'Cannot start terminated instance'
    );
  });
});

describe('modifyInstanceType', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEC2Send.mockResolvedValue({});
  });

  it('sends ModifyInstanceAttributeCommand with correct params', async () => {
    await modifyInstanceType('i-abc123', 'us-east-1', 't3.large');

    const input = (
      mockEC2Send.mock.calls[0][0] as {
        input: { InstanceId: string; InstanceType: { Value: string } };
      }
    ).input;
    expect(input.InstanceId).toBe('i-abc123');
    expect(input.InstanceType).toEqual({ Value: 't3.large' });
  });

  it('propagates errors from EC2', async () => {
    mockEC2Send.mockRejectedValueOnce(new Error('Instance must be stopped'));

    await expect(modifyInstanceType('i-running', 'us-east-1', 'm6i.large')).rejects.toThrow(
      'Instance must be stopped'
    );
  });
});

describe('setInstanceTag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEC2Send.mockResolvedValue({});
  });

  it('sends CreateTagsCommand with correct Resources and Tags', async () => {
    await setInstanceTag('i-abc123', 'us-east-1', 'clawdult:status', 'resizing');

    const input = (
      mockEC2Send.mock.calls[0][0] as {
        input: { Resources: string[]; Tags: Array<{ Key: string; Value: string }> };
      }
    ).input;
    expect(input.Resources).toEqual(['i-abc123']);
    expect(input.Tags).toEqual([{ Key: 'clawdult:status', Value: 'resizing' }]);
  });

  it('propagates errors from EC2', async () => {
    mockEC2Send.mockRejectedValueOnce(new Error('Not authorized'));

    await expect(setInstanceTag('i-abc', 'us-east-1', 'k', 'v')).rejects.toThrow('Not authorized');
  });
});

describe('deleteInstanceTag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEC2Send.mockResolvedValue({});
  });

  it('sends DeleteTagsCommand with correct Resources and Tags key', async () => {
    await deleteInstanceTag('i-abc123', 'us-east-1', 'clawdult:status');

    const input = (
      mockEC2Send.mock.calls[0][0] as {
        input: { Resources: string[]; Tags: Array<{ Key: string }> };
      }
    ).input;
    expect(input.Resources).toEqual(['i-abc123']);
    expect(input.Tags).toEqual([{ Key: 'clawdult:status' }]);
  });

  it('propagates errors from EC2', async () => {
    mockEC2Send.mockRejectedValueOnce(new Error('Not authorized'));

    await expect(deleteInstanceTag('i-abc', 'us-east-1', 'k')).rejects.toThrow('Not authorized');
  });
});

describe('createAmiFromInstance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends CreateImageCommand with correct params and returns ImageId', async () => {
    mockEC2Send.mockResolvedValueOnce({ ImageId: 'ami-new123' });

    const imageId = await createAmiFromInstance(
      'i-abc123',
      'us-east-1',
      'clawdult-snapshot-agent',
      'Snapshot of agent'
    );

    expect(imageId).toBe('ami-new123');

    const input = (mockEC2Send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.InstanceId).toBe('i-abc123');
    expect(input.Name).toBe('clawdult-snapshot-agent');
    expect(input.Description).toBe('Snapshot of agent');
    expect(input.NoReboot).toBe(false);
  });

  it('includes TagSpecifications for both image and snapshot', async () => {
    mockEC2Send.mockResolvedValueOnce({ ImageId: 'ami-new123' });

    await createAmiFromInstance('i-abc123', 'us-east-1', 'my-ami');

    const input = (mockEC2Send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    const tagSpecs = input.TagSpecifications as Array<{
      ResourceType: string;
      Tags: Array<{ Key: string; Value: string }>;
    }>;

    expect(tagSpecs).toHaveLength(2);

    const imageSpec = tagSpecs.find((s) => s.ResourceType === 'image');
    expect(imageSpec!.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'Name', Value: 'my-ami' },
        { Key: 'clawdult:managed', Value: 'true' },
      ])
    );

    const snapshotSpec = tagSpecs.find((s) => s.ResourceType === 'snapshot');
    expect(snapshotSpec!.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'Name', Value: 'my-ami-snapshot' },
        { Key: 'clawdult:managed', Value: 'true' },
      ])
    );
  });

  it('throws when CreateImage returns no ImageId', async () => {
    mockEC2Send.mockResolvedValueOnce({});

    await expect(createAmiFromInstance('i-abc123', 'us-east-1', 'name')).rejects.toThrow(
      'CreateImage returned no ImageId'
    );
  });
});

describe('describeAmi', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns AmiInfo on success', async () => {
    mockEC2Send.mockResolvedValueOnce({
      Images: [
        {
          ImageId: 'ami-123',
          Name: 'my-ami',
          State: 'available',
          Description: 'Test AMI',
        },
      ],
    });

    const info = await describeAmi('ami-123', 'us-east-1');

    expect(info).toEqual({
      imageId: 'ami-123',
      name: 'my-ami',
      state: 'available',
      description: 'Test AMI',
    });
  });

  it('returns null on InvalidAMIID.NotFound', async () => {
    const error = new Error('AMI not found');
    error.name = 'InvalidAMIID.NotFound';
    mockEC2Send.mockRejectedValueOnce(error);

    const info = await describeAmi('ami-gone', 'us-east-1');
    expect(info).toBeNull();
  });

  it('returns null on empty Images array', async () => {
    mockEC2Send.mockResolvedValueOnce({ Images: [] });

    const info = await describeAmi('ami-empty', 'us-east-1');
    expect(info).toBeNull();
  });

  it('propagates other errors', async () => {
    const error = new Error('Forbidden');
    error.name = 'ForbiddenException';
    mockEC2Send.mockRejectedValueOnce(error);

    await expect(describeAmi('ami-123', 'us-east-1')).rejects.toThrow('Forbidden');
  });
});

describe('copyAmiToRegion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends CopyImageCommand and returns new ImageId', async () => {
    mockEC2Send.mockResolvedValueOnce({ ImageId: 'ami-dest456' });

    const newId = await copyAmiToRegion('ami-src123', 'us-east-1', 'us-west-2', 'copied-ami');

    expect(newId).toBe('ami-dest456');

    const input = (mockEC2Send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.SourceImageId).toBe('ami-src123');
    expect(input.SourceRegion).toBe('us-east-1');
    expect(input.Name).toBe('copied-ami');
    expect(input.Description).toBe('Copy of ami-src123 from us-east-1');
  });

  it('throws when CopyImage returns no ImageId', async () => {
    mockEC2Send.mockResolvedValueOnce({});

    await expect(copyAmiToRegion('ami-src', 'us-east-1', 'us-west-2', 'name')).rejects.toThrow(
      'CopyImage returned no ImageId'
    );
  });
});

describe('deregisterAmi', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEC2Send.mockResolvedValue({});
  });

  it('sends DeregisterImageCommand with correct ImageId', async () => {
    await deregisterAmi('ami-old123', 'us-east-1');

    const input = (mockEC2Send.mock.calls[0][0] as { input: { ImageId: string } }).input;
    expect(input.ImageId).toBe('ami-old123');
  });
});

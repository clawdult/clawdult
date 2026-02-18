packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.0"
      source  = "github.com/hashicorp/amazon"
    }
    ansible = {
      version = ">= 1.1.0"
      source  = "github.com/hashicorp/ansible"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "t3.large"
}

variable "ami_name_prefix" {
  type    = string
  default = "clawdult"
}

variable "version" {
  type    = string
  default = "0.1.0"
}

variable "vpc_id" {
  type    = string
  default = ""
  description = "VPC ID for the build instance. Uses default VPC when empty."
}

variable "subnet_id" {
  type    = string
  default = ""
  description = "Subnet ID for the build instance. Uses default subnet when empty."
}

variable "ubuntu_version" {
  type    = string
  default = "24.04"
  description = "Ubuntu LTS version to use for the AMI"
}

variable "ubuntu_codename" {
  type    = string
  default = "noble"
  description = "Ubuntu release codename (noble for 24.04, jammy for 22.04)"
}

locals {
  timestamp = formatdate("YYYYMMDD-hhmmss", timestamp())
  ami_name  = "${var.ami_name_prefix}-${var.version}-${local.timestamp}"
}

source "amazon-ebs" "ubuntu" {
  ami_name      = local.ami_name
  instance_type = var.instance_type
  region        = var.aws_region
  vpc_id    = var.vpc_id != "" ? var.vpc_id : null
  subnet_id = var.subnet_id != "" ? var.subnet_id : null

  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-${var.ubuntu_codename}-${var.ubuntu_version}-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }

  ssh_username = "ubuntu"

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 50
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name               = local.ami_name
    Version            = var.version
    BuildTime          = local.timestamp
    Application        = "clawdult"
    "clawdult:managed" = "true"
  }

  run_tags = {
    Name               = "packer-clawdult-builder"
    "clawdult:managed" = "true"
  }

  snapshot_tags = {
    Name               = "${local.ami_name}-snapshot"
    Application        = "clawdult"
    "clawdult:managed" = "true"
  }

  security_group_filter {
    filters = {
      "tag:Name" = "clawdult-packer-builder"
    }
  }
}

build {
  name    = "clawdult-ami"
  sources = ["source.amazon-ebs.ubuntu"]

  # Wait for cloud-init to complete
  provisioner "shell" {
    inline = [
      "while [ ! -f /var/lib/cloud/instance/boot-finished ]; do echo 'Waiting for cloud-init...'; sleep 5; done",
      "echo 'Cloud-init completed'"
    ]
  }

  # Install Ansible
  provisioner "shell" {
    inline = [
      "sudo apt-get update",
      "sudo apt-get install -y software-properties-common",
      "sudo add-apt-repository --yes --update ppa:ansible/ansible",
      "sudo apt-get install -y ansible"
    ]
  }

  # Create destination directory for Ansible playbooks
  provisioner "shell" {
    inline = ["mkdir -p /tmp/ansible"]
  }

  # Copy Ansible playbooks
  provisioner "file" {
    source      = "../ansible/"
    destination = "/tmp/ansible"
  }

  # Run Ansible
  provisioner "shell" {
    inline = [
      "cd /tmp/ansible",
      "sudo ansible-playbook -c local -i 'localhost,' site.yml"
    ]
  }

  # Cleanup
  provisioner "shell" {
    inline = [
      "sudo rm -rf /tmp/ansible",
      "sudo apt-get remove -y ansible && sudo apt-get autoremove -y",
      "sudo apt-get clean",
      "sudo rm -rf /var/lib/apt/lists/*",
      "sudo rm -rf /home/ubuntu/.ssh/authorized_keys",
      "sudo rm -rf /root/.ssh/authorized_keys"
    ]
  }

  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
  }
}

#!/bin/bash

# Secure GCP Deployment Script for WhatsApp API
echo "🔒 Starting SECURE WhatsApp API deployment on GCP VM..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
YOUR_IP="180.242.196.179"
VM_NAME="whatsapp-api-server"
ZONE="us-central1-a"
PROJECT_DIR="whatsapp-api"

echo -e "${BLUE}📋 Deployment Configuration:${NC}"
echo -e "   VM Name: ${VM_NAME}"
echo -e "   Zone: ${ZONE}"
echo -e "   Allowed IP: ${YOUR_IP}"
echo -e "   Project Directory: ${PROJECT_DIR}"
echo ""

# Step 1: Create VM Instance
echo -e "${YELLOW}🚀 Step 1: Creating GCP VM Instance...${NC}"
gcloud compute instances create ${VM_NAME} \
    --zone=${ZONE} \
    --machine-type=e2-micro \
    --subnet=default \
    --network-tier=PREMIUM \
    --maintenance-policy=MIGRATE \
    --image=ubuntu-2004-focal-v20231101 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=20GB \
    --boot-disk-type=pd-standard \
    --tags=whatsapp-api,http-server \
    --metadata=startup-script='#!/bin/bash
    apt update
    apt install -y curl
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
    npm install -g pm2
    '

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ VM Instance created successfully${NC}"
else
    echo -e "${RED}❌ Failed to create VM Instance${NC}"
    exit 1
fi

# Step 2: Create Secure Firewall Rules
echo -e "${YELLOW}🔒 Step 2: Creating secure firewall rules...${NC}"

# Allow SSH from your IP only
gcloud compute firewall-rules create allow-ssh-secure \
    --allow tcp:22 \
    --source-ranges ${YOUR_IP}/32 \
    --target-tags whatsapp-api \
    --description "Allow SSH from specific IP only"

# Allow WhatsApp API from your IP only
gcloud compute firewall-rules create allow-whatsapp-api-secure \
    --allow tcp:3000 \
    --source-ranges ${YOUR_IP}/32 \
    --target-tags whatsapp-api \
    --description "Allow WhatsApp API from specific IP only"

# Allow HTTP/HTTPS for Nginx (optional)
gcloud compute firewall-rules create allow-http-secure \
    --allow tcp:80,tcp:443 \
    --source-ranges ${YOUR_IP}/32 \
    --target-tags whatsapp-api \
    --description "Allow HTTP/HTTPS from specific IP only"

echo -e "${GREEN}✅ Secure firewall rules created${NC}"

# Step 3: Wait for VM to be ready
echo -e "${YELLOW}⏳ Step 3: Waiting for VM to be ready...${NC}"
sleep 30

# Step 4: Setup VM Environment
echo -e "${YELLOW}🛠️ Step 4: Setting up VM environment...${NC}"
gcloud compute ssh ${VM_NAME} --zone=${ZONE} --command="
    # Create project directory
    mkdir -p ~/${PROJECT_DIR}
    cd ~/${PROJECT_DIR}
    
    # Install additional dependencies
    sudo apt update
    sudo apt install -y nginx apache2-utils git htop
    
    # Create necessary directories
    mkdir -p sessions logs
    
    echo '✅ VM environment setup complete'
"

echo -e "${GREEN}✅ Secure deployment script completed!${NC}"
echo ""
echo -e "${BLUE}📝 Next Steps:${NC}"
echo -e "1. Upload your project files to the VM"
echo -e "2. Configure environment variables"
echo -e "3. Start the application with PM2"
echo ""
echo -e "${BLUE}🔑 Connection Info:${NC}"
echo -e "   SSH: gcloud compute ssh ${VM_NAME} --zone=${ZONE}"
echo -e "   Upload: gcloud compute scp --recurse . ${VM_NAME}:~/${PROJECT_DIR}/ --zone=${ZONE}"
echo ""
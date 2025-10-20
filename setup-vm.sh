#!/bin/bash

# VM Setup Script - Run this ON the GCP VM after uploading files
echo "🔧 Setting up WhatsApp API on GCP VM..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Credentials (SAVE THESE!)
API_USERNAME="whatsapp_admin"
API_PASSWORD="SecurePass2024!@#"
NGINX_USER="felix"
NGINX_PASS="Felix@API2024"

echo -e "${BLUE}🔑 CREDENTIALS - SAVE THESE:${NC}"
echo -e "   API Username: ${API_USERNAME}"
echo -e "   API Password: ${API_PASSWORD}"
echo -e "   Nginx Username: ${NGINX_USER}"
echo -e "   Nginx Password: ${NGINX_PASS}"
echo ""

# Update system
echo -e "${YELLOW}📦 Updating system packages...${NC}"
sudo apt update && sudo apt upgrade -y

# Install Node.js if not already installed
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}📦 Installing Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install PM2 globally
echo -e "${YELLOW}📦 Installing PM2...${NC}"
sudo npm install -g pm2

# Install Nginx and utilities
echo -e "${YELLOW}📦 Installing Nginx and utilities...${NC}"
sudo apt install -y nginx apache2-utils htop ufw

# Navigate to project directory
cd ~/whatsapp-api

# Install project dependencies
echo -e "${YELLOW}📦 Installing project dependencies...${NC}"
npm install

# Create production environment file
echo -e "${YELLOW}⚙️ Creating production environment...${NC}"
cat > .env << EOF
# Production Environment Configuration
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
SESSION_DIR=./sessions
AUTO_REPLY=false
ENABLE_PAIRING_CODE=true

# API Security
API_USERNAME=${API_USERNAME}
API_PASSWORD=${API_PASSWORD}

# Claude API (UPDATE THIS WITH YOUR ACTUAL KEY!)
CLAUDE_API_KEY=your-claude-api-key-here

# WhatsApp Configuration
AUTO_REPLY=false
ENABLE_PAIRING_CODE=true
EOF

# Create necessary directories
mkdir -p sessions logs

# Build the project
echo -e "${YELLOW}🔨 Building project...${NC}"
npm run build

# Setup Nginx with authentication
echo -e "${YELLOW}🔒 Setting up Nginx with authentication...${NC}"

# Create password file for Nginx
sudo htpasswd -cb /etc/nginx/.htpasswd ${NGINX_USER} ${NGINX_PASS}

# Copy Nginx configuration
sudo cp nginx-secure.conf /etc/nginx/sites-available/whatsapp-api
sudo ln -sf /etc/nginx/sites-available/whatsapp-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test Nginx configuration
sudo nginx -t

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Nginx configuration is valid${NC}"
    sudo systemctl restart nginx
    sudo systemctl enable nginx
else
    echo -e "${RED}❌ Nginx configuration error${NC}"
    exit 1
fi

# Setup UFW firewall
echo -e "${YELLOW}🔥 Configuring UFW firewall...${NC}"
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp
sudo ufw --force enable

# Start application with PM2
echo -e "${YELLOW}🚀 Starting application with PM2...${NC}"
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Setup PM2 startup script
sudo pm2 startup systemd -u $USER --hp $HOME

# Enable PM2 service
sudo systemctl enable pm2-$USER

echo -e "${GREEN}✅ Setup completed successfully!${NC}"
echo ""
echo -e "${BLUE}🌐 Access Information:${NC}"
echo -e "   Direct API: http://$(curl -s ifconfig.me):3000"
echo -e "   Nginx Proxy: http://$(curl -s ifconfig.me)"
echo ""
echo -e "${BLUE}🔑 Login Credentials:${NC}"
echo -e "   Username: ${NGINX_USER}"
echo -e "   Password: ${NGINX_PASS}"
echo ""
echo -e "${BLUE}📊 Management Commands:${NC}"
echo -e "   Monitor: pm2 monit"
echo -e "   Logs: pm2 logs"
echo -e "   Restart: pm2 restart whatsapp-api"
echo -e "   Status: pm2 status"
echo ""
echo -e "${YELLOW}⚠️ IMPORTANT: Update your CLAUDE_API_KEY in .env file!${NC}"
echo -e "   Edit: nano .env"
echo -e "   Restart: pm2 restart whatsapp-api"
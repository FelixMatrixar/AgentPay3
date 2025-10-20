# 🔒 Secure GCP Deployment Guide

## 🔑 **CREDENTIALS - SAVE THESE!**

### **Nginx Authentication:**
- **Username:** `felix`
- **Password:** `Felix@API2024`

### **API Authentication:**
- **Username:** `whatsapp_admin`
- **Password:** `SecurePass2024!@#`

### **Your Secure IP:**
- **Allowed IP:** `180.242.196.179/32`

---

## 🚀 **Quick Deployment Steps**

### **Step 1: Deploy to GCP**
```bash
# Make scripts executable
chmod +x deploy-secure.sh
chmod +x setup-vm.sh
chmod +x update-firewall-ip.sh

# Run deployment script
./deploy-secure.sh
```

### **Step 2: Upload Project Files**
```bash
# Upload all files to VM
gcloud compute scp --recurse . whatsapp-api-server:~/whatsapp-api/ --zone=us-central1-a
```

### **Step 3: Setup VM Environment**
```bash
# Connect to VM
gcloud compute ssh whatsapp-api-server --zone=us-central1-a

# Run setup script
cd ~/whatsapp-api
chmod +x setup-vm.sh
./setup-vm.sh
```

### **Step 4: Update Environment Variables**
```bash
# Edit .env file on VM
nano .env

# Update CLAUDE_API_KEY with your actual key
# Save and exit (Ctrl+X, Y, Enter)

# Restart application
pm2 restart whatsapp-api
```

---

## 🌐 **Access Your API**

### **Direct API Access:**
- **URL:** `http://[VM_EXTERNAL_IP]:3000`
- **No authentication required for direct access**

### **Nginx Proxy Access (Recommended):**
- **URL:** `http://[VM_EXTERNAL_IP]`
- **Username:** `felix`
- **Password:** `Felix@API2024`

### **Health Check (No Auth):**
- **URL:** `http://[VM_EXTERNAL_IP]/health`

---

## 🔧 **Management Commands**

### **On the VM:**
```bash
# Monitor application
pm2 monit

# View logs
pm2 logs whatsapp-api

# Restart application
pm2 restart whatsapp-api

# Check status
pm2 status

# View Nginx logs
sudo tail -f /var/log/nginx/whatsapp-api-access.log
sudo tail -f /var/log/nginx/whatsapp-api-error.log
```

### **From Local Machine:**
```bash
# Connect to VM
gcloud compute ssh whatsapp-api-server --zone=us-central1-a

# Update firewall when IP changes
./update-firewall-ip.sh

# Upload updated files
gcloud compute scp --recurse . whatsapp-api-server:~/whatsapp-api/ --zone=us-central1-a
```

---

## 🔒 **Security Features**

### **Firewall Protection:**
- ✅ SSH access only from your IP (`180.242.196.179/32`)
- ✅ API access only from your IP
- ✅ HTTP/HTTPS access only from your IP
- ✅ All other traffic blocked

### **Nginx Security:**
- ✅ Basic authentication required
- ✅ Rate limiting (10 requests/minute)
- ✅ Security headers enabled
- ✅ Access logging enabled
- ✅ Sensitive file access blocked

### **Application Security:**
- ✅ Production environment
- ✅ Process monitoring with PM2
- ✅ Auto-restart on crashes
- ✅ Memory limit protection
- ✅ UFW firewall enabled

---

## 📊 **Monitoring & Maintenance**

### **Check Application Status:**
```bash
# PM2 status
pm2 status

# System resources
htop

# Disk usage
df -h

# Memory usage
free -h
```

### **Update Application:**
```bash
# On local machine - upload changes
gcloud compute scp --recurse . whatsapp-api-server:~/whatsapp-api/ --zone=us-central1-a

# On VM - rebuild and restart
cd ~/whatsapp-api
npm run build
pm2 restart whatsapp-api
```

### **Backup Session Data:**
```bash
# Create backup
tar -czf sessions-backup-$(date +%Y%m%d).tar.gz sessions/

# Download backup to local
gcloud compute scp whatsapp-api-server:~/whatsapp-api/sessions-backup-*.tar.gz . --zone=us-central1-a
```

---

## 🆘 **Troubleshooting**

### **If IP Changes:**
```bash
# Run this script to update firewall rules
./update-firewall-ip.sh
```

### **If Application Won't Start:**
```bash
# Check logs
pm2 logs whatsapp-api

# Check environment
cat .env

# Restart PM2
pm2 restart whatsapp-api
```

### **If Nginx Issues:**
```bash
# Check Nginx status
sudo systemctl status nginx

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

### **If Can't Connect:**
1. Check your current IP: `curl ifconfig.me`
2. Update firewall rules: `./update-firewall-ip.sh`
3. Verify VM is running: `gcloud compute instances list`
4. Check firewall rules: `gcloud compute firewall-rules list`

---

## 💰 **Cost Optimization**

### **Current Setup Cost (~$8-12/month):**
- **VM Instance (e2-micro):** ~$5-7/month
- **Network Egress:** ~$1-3/month
- **Storage (20GB):** ~$2/month

### **To Reduce Costs:**
- Use preemptible instances (50-70% cheaper)
- Stop VM when not needed
- Use smaller disk size if possible
- Monitor usage with GCP billing alerts

---

## 🎯 **Next Steps**

1. ✅ Deploy VM with secure configuration
2. ✅ Upload and setup application
3. ✅ Update CLAUDE_API_KEY in .env
4. ✅ Test WhatsApp connection
5. ✅ Setup monitoring and alerts
6. ✅ Create backup schedule
7. ✅ Document API endpoints for your team

**Your WhatsApp API is now running securely 24/7 on GCP! 🚀**
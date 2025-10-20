#!/bin/bash

# Script to update GCP firewall rules when your IP changes
echo "🔄 Updating firewall rules for new IP address..."

# Get current IP
CURRENT_IP=$(curl -s ifconfig.me)
echo "Current IP: $CURRENT_IP"

if [ -z "$CURRENT_IP" ]; then
    echo "❌ Failed to get current IP address"
    exit 1
fi

# Update firewall rules
echo "🔒 Updating SSH firewall rule..."
gcloud compute firewall-rules update allow-ssh-secure \
    --source-ranges $CURRENT_IP/32

echo "🔒 Updating WhatsApp API firewall rule..."
gcloud compute firewall-rules update allow-whatsapp-api-secure \
    --source-ranges $CURRENT_IP/32

echo "🔒 Updating HTTP firewall rule..."
gcloud compute firewall-rules update allow-http-secure \
    --source-ranges $CURRENT_IP/32

if [ $? -eq 0 ]; then
    echo "✅ All firewall rules updated successfully for IP: $CURRENT_IP"
    echo ""
    echo "📋 Updated Rules:"
    echo "   SSH Access: $CURRENT_IP/32"
    echo "   API Access: $CURRENT_IP/32"
    echo "   HTTP Access: $CURRENT_IP/32"
else
    echo "❌ Failed to update firewall rules"
    exit 1
fi

echo ""
echo "🌐 You can now access your services:"
echo "   SSH: gcloud compute ssh whatsapp-api-server --zone=us-central1-a"
echo "   API: http://[VM_EXTERNAL_IP]:3000"
echo "   Nginx: http://[VM_EXTERNAL_IP]"
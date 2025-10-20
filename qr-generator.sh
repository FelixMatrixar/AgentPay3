#!/bin/bash

# WhatsApp QR Code Generator Script (Bash Version)
# This script provides an easy interface to generate QR codes for WhatsApp sessions

# Configuration
API_BASE_URL="http://34.121.26.54:3000/api"

# Default values
FORMAT="png"
SIZE=512
MARGIN=2
DIR="./qr-codes"
USE_TIMESTAMP=true

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Function to print colored output
print_color() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# Function to print usage
show_usage() {
    echo ""
    print_color "$CYAN" "🔧 WhatsApp QR Code Generator (Bash)"
    echo ""
    echo "Usage:"
    echo "  ./qr-generator.sh [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo "  generate <session_id>                    Generate QR code from existing session"
    echo "  create <phone_number> <session_id>       Create new session with custom ID and generate QR code"
    echo "  create-auto <phone_number>               Create new session with auto-generated ID and generate QR code"
    echo "  from-string <qr_string>                  Generate QR code from QR string"
    echo "  list-sessions                            List all WhatsApp sessions"
    echo "  help                                     Show this help message"
    echo ""
    echo "Phone Number Format:"
    print_color "$YELLOW" "  📱 Use phone number WITHOUT the '+' prefix"
    print_color "$YELLOW" "  ✅ Correct:   6285168671319"
    print_color "$YELLOW" "  ❌ Incorrect: +6285168671319"
    echo ""
    echo "Options:"
    echo "  --output <path>                Output file path (default: auto-generated)"
    echo "  --format <format>              Image format: png or svg (default: png)"
    echo "  --size <pixels>                Image size in pixels (default: 512)"
    echo "  --margin <margin>              Margin size (default: 2)"
    echo "  --dir <directory>              Output directory (default: ./qr-codes)"
    echo "  --no-timestamp                 Don't add timestamp to filename"
    echo ""
    echo "Examples:"
    echo "  ./qr-generator.sh generate felix_main"
    echo "  ./qr-generator.sh create 6285168671319 felix_indonesia"
    echo "  ./qr-generator.sh create-auto 6285168671319"
    echo "  ./qr-generator.sh from-string \"2@ABC123...\" --output whatsapp-qr.png"
    echo "  ./qr-generator.sh list-sessions"
    echo ""
}

# Function to check dependencies
check_dependencies() {
    if ! command -v node &> /dev/null; then
        print_color "$RED" "❌ Error: Node.js is not installed or not in PATH"
        exit 1
    fi

    if [ ! -f "generate-qr-image.js" ]; then
        print_color "$RED" "❌ Error: generate-qr-image.js not found in current directory"
        exit 1
    fi

    if [ ! -f "package.json" ]; then
        print_color "$RED" "❌ Error: package.json not found. Run 'npm install' first"
        exit 1
    fi
}

# Function to create output directory
create_output_directory() {
    local directory=$1
    
    if [ ! -d "$directory" ]; then
        mkdir -p "$directory"
        print_color "$BLUE" "📁 Created directory: $directory"
    fi
}

# Function to generate timestamp
get_timestamp() {
    date +"%Y%m%d_%H%M%S"
}

# Function to list sessions
list_sessions() {
    print_color "$BLUE" "📋 Fetching WhatsApp sessions..."
    
    local response
    response=$(curl -s "$API_BASE_URL/sessions" 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        print_color "$RED" "❌ Failed to fetch sessions from API"
        exit 1
    fi
    
    echo ""
    echo "📱 WhatsApp Sessions:"
    echo "=================================================="
    
    # Parse JSON response (basic parsing - requires jq for complex parsing)
    if command -v jq &> /dev/null; then
        local count=$(echo "$response" | jq '. | length')
        
        if [ "$count" -eq 0 ]; then
            echo "No sessions found."
        else
            for ((i=0; i<count; i++)); do
                local session=$(echo "$response" | jq ".[$i]")
                local id=$(echo "$session" | jq -r '.id')
                local phone=$(echo "$session" | jq -r '.phoneNumber // "N/A"')
                local connected=$(echo "$session" | jq -r '.isConnected')
                local status
                
                if [ "$connected" = "true" ]; then
                    status="🟢 Connected"
                else
                    status="🔴 Disconnected"
                fi
                
                echo "$((i+1)). ID: $id"
                echo "   Phone: $phone"
                echo "   Status: $status"
                echo ""
            done
        fi
    else
        print_color "$YELLOW" "⚠️  jq not installed. Showing raw response:"
        echo "$response"
    fi
}

# Function to get QR code from session
get_qr_from_session() {
    local session_id=$1
    
    print_color "$BLUE" "🔍 Fetching QR code for session: $session_id"
    
    local response
    response=$(curl -s "$API_BASE_URL/sessions/$session_id/qr" 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        print_color "$RED" "❌ QR code not available for session: $session_id"
        print_color "$YELLOW" "💡 Try creating a new session or check if the session exists"
        exit 1
    fi
    
    local qr_code
    if command -v jq &> /dev/null; then
        qr_code=$(echo "$response" | jq -r '.qrCode // .qr // empty')
    else
        # Basic extraction without jq
        qr_code=$(echo "$response" | grep -o '"qrCode":"[^"]*"' | cut -d'"' -f4)
        if [ -z "$qr_code" ]; then
            qr_code=$(echo "$response" | grep -o '"qr":"[^"]*"' | cut -d'"' -f4)
        fi
    fi
    
    if [ -z "$qr_code" ]; then
        print_color "$RED" "❌ No QR code found in response"
        exit 1
    fi
    
    echo "$qr_code"
}

# Function to create new session
create_session() {
    local phone_number=$1
    local custom_session_id=$2
    
    local session_id
    if [ -n "$custom_session_id" ]; then
        session_id="$custom_session_id"
    else
        session_id="qr_session_$(get_timestamp)"
    fi
    
    print_color "$BLUE" "🆕 Creating new session: $session_id"
    
    local json_body="{\"userId\":\"$session_id\",\"phoneNumber\":\"$phone_number\"}"
    
    local response
    response=$(curl -s -X POST "$API_BASE_URL/sessions" \
        -H "Content-Type: application/json" \
        -d "$json_body" 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        print_color "$RED" "❌ Failed to create session"
        exit 1
    fi
    
    print_color "$GREEN" "✅ Session created successfully: $session_id"
    print_color "$YELLOW" "⏳ Waiting 5 seconds for QR code generation..."
    sleep 5
    
    echo "$session_id"
}

# Function to generate QR image
generate_qr_image() {
    local qr_string=$1
    local output_path=$2
    local format=$3
    local size=$4
    local margin=$5
    
    print_color "$BLUE" "🎨 Generating QR code image..."
    
    if node generate-qr-image.js "$qr_string" "$output_path" "$format" "$size" "$margin"; then
        print_color "$GREEN" "✅ QR code image generated successfully: $output_path"
        
        if [ -f "$output_path" ]; then
            local file_size=$(du -h "$output_path" | cut -f1)
            print_color "$CYAN" "📏 File size: $file_size"
        fi
        return 0
    else
        print_color "$RED" "❌ Failed to generate QR code image"
        return 1
    fi
}

# Function to generate output filename
get_output_filename() {
    local session_id=$1
    local format=$2
    local output_dir=$3
    local use_timestamp=$4
    
    local base_name
    if [ -n "$session_id" ]; then
        base_name="whatsapp-qr-$session_id"
    else
        base_name="whatsapp-qr-manual"
    fi
    
    if [ "$use_timestamp" = true ]; then
        local timestamp=$(get_timestamp)
        echo "$output_dir/$base_name-$timestamp.$format"
    else
        echo "$output_dir/$base_name.$format"
    fi
}

# Function to validate phone number
validate_phone_number() {
    local phone_number=$1
    
    if [[ "$phone_number" == +* ]]; then
        print_color "$RED" "❌ Phone number should NOT include '+' prefix"
        print_color "$YELLOW" "💡 Use: ${phone_number:1} (without +)"
        return 1
    fi
    return 0
}

# Parse command line arguments
COMMAND=""
ARG1=""
ARG2=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --output)
            OUTPUT="$2"
            shift 2
            ;;
        --format)
            FORMAT="$2"
            shift 2
            ;;
        --size)
            SIZE="$2"
            shift 2
            ;;
        --margin)
            MARGIN="$2"
            shift 2
            ;;
        --dir)
            DIR="$2"
            shift 2
            ;;
        --no-timestamp)
            USE_TIMESTAMP=false
            shift
            ;;
        help)
            show_usage
            exit 0
            ;;
        *)
            if [ -z "$COMMAND" ]; then
                COMMAND="$1"
            elif [ -z "$ARG1" ]; then
                ARG1="$1"
            elif [ -z "$ARG2" ]; then
                ARG2="$1"
            fi
            shift
            ;;
    esac
done

# Show usage if no command provided
if [ -z "$COMMAND" ]; then
    show_usage
    exit 0
fi

# Check dependencies
check_dependencies

# Execute command
case "$COMMAND" in
    "list-sessions")
        list_sessions
        ;;
    
    "generate")
        if [ -z "$ARG1" ]; then
            print_color "$RED" "❌ Session ID is required for generate command"
            exit 1
        fi
        
        create_output_directory "$DIR"
        
        if [ -z "$OUTPUT" ]; then
            OUTPUT=$(get_output_filename "$ARG1" "$FORMAT" "$DIR" "$USE_TIMESTAMP")
        fi
        
        QR_CODE=$(get_qr_from_session "$ARG1")
        generate_qr_image "$QR_CODE" "$OUTPUT" "$FORMAT" "$SIZE" "$MARGIN" || exit 1
        ;;
    
    "create")
        if [ -z "$ARG1" ]; then
            print_color "$RED" "❌ Phone number is required for create command"
            print_color "$YELLOW" "💡 Usage: ./qr-generator.sh create <phone_number> <session_id>"
            print_color "$YELLOW" "💡 Example: ./qr-generator.sh create 6285168671319 felix_indonesia"
            exit 1
        fi
        
        if [ -z "$ARG2" ]; then
            print_color "$RED" "❌ Session ID is required for create command"
            print_color "$YELLOW" "💡 Usage: ./qr-generator.sh create <phone_number> <session_id>"
            print_color "$YELLOW" "💡 Example: ./qr-generator.sh create 6285168671319 felix_indonesia"
            exit 1
        fi
        
        validate_phone_number "$ARG1" || exit 1
        
        create_output_directory "$DIR"
        
        CREATED_SESSION_ID=$(create_session "$ARG1" "$ARG2")
        
        if [ -z "$OUTPUT" ]; then
            OUTPUT=$(get_output_filename "$CREATED_SESSION_ID" "$FORMAT" "$DIR" "$USE_TIMESTAMP")
        fi
        
        QR_CODE=$(get_qr_from_session "$CREATED_SESSION_ID")
        generate_qr_image "$QR_CODE" "$OUTPUT" "$FORMAT" "$SIZE" "$MARGIN" || exit 1
        ;;
    
    "create-auto")
        if [ -z "$ARG1" ]; then
            print_color "$RED" "❌ Phone number is required for create-auto command"
            print_color "$YELLOW" "💡 Usage: ./qr-generator.sh create-auto <phone_number>"
            print_color "$YELLOW" "💡 Example: ./qr-generator.sh create-auto 6285168671319"
            exit 1
        fi
        
        validate_phone_number "$ARG1" || exit 1
        
        create_output_directory "$DIR"
        
        CREATED_SESSION_ID=$(create_session "$ARG1")
        
        if [ -z "$OUTPUT" ]; then
            OUTPUT=$(get_output_filename "$CREATED_SESSION_ID" "$FORMAT" "$DIR" "$USE_TIMESTAMP")
        fi
        
        QR_CODE=$(get_qr_from_session "$CREATED_SESSION_ID")
        generate_qr_image "$QR_CODE" "$OUTPUT" "$FORMAT" "$SIZE" "$MARGIN" || exit 1
        ;;
    
    "from-string")
        if [ -z "$ARG1" ]; then
            print_color "$RED" "❌ QR string is required for from-string command"
            exit 1
        fi
        
        create_output_directory "$DIR"
        
        if [ -z "$OUTPUT" ]; then
            OUTPUT=$(get_output_filename "" "$FORMAT" "$DIR" "$USE_TIMESTAMP")
        fi
        
        generate_qr_image "$ARG1" "$OUTPUT" "$FORMAT" "$SIZE" "$MARGIN" || exit 1
        ;;
    
    *)
        print_color "$RED" "❌ Unknown command: $COMMAND"
        show_usage
        exit 1
        ;;
esac

print_color "$GREEN" "🎉 Process completed successfully!"
print_color "$CYAN" "📱 You can now scan the QR code with WhatsApp to connect your device."
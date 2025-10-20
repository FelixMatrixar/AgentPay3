#!/usr/bin/env powershell

# WhatsApp QR Code Generator Script (PowerShell Version)
# This script provides an easy interface to generate QR codes for WhatsApp sessions

param(
    [Parameter(Position=0)]
    [string]$Command,
    
    [Parameter(Position=1)]
    [string]$Arg1,
    
    [Parameter(Position=2)]
    [string]$Arg2,
    
    [Parameter(Position=3)]
    [string]$Arg3,
    
    [string]$Output,
    [string]$Format = "png",
    [int]$Size = 512,
    [int]$Margin = 2,
    [string]$Dir = "./qr-codes",
    [switch]$NoTimestamp
)

# Configuration
$API_BASE_URL = "http://34.121.26.54:3000/api"

# Function to print colored output
function Write-ColorOutput {
    param(
        [string]$Color,
        [string]$Message
    )
    
    switch ($Color) {
        "Red" { Write-Host $Message -ForegroundColor Red }
        "Green" { Write-Host $Message -ForegroundColor Green }
        "Yellow" { Write-Host $Message -ForegroundColor Yellow }
        "Blue" { Write-Host $Message -ForegroundColor Blue }
        "Cyan" { Write-Host $Message -ForegroundColor Cyan }
        "Magenta" { Write-Host $Message -ForegroundColor Magenta }
        default { Write-Host $Message }
    }
}

# Function to print usage
function Show-Usage {
    Write-Host ""
    Write-ColorOutput "Cyan" "🔧 WhatsApp QR Code Generator (PowerShell)"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\qr-generator.ps1 [COMMAND] [OPTIONS]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  generate <session_id>                    Generate QR code from existing session"
    Write-Host "  create <phone_number> <session_id>       Create new session with custom ID and generate QR code"
    Write-Host "  create-auto <phone_number>               Create new session with auto-generated ID and generate QR code"
    Write-Host "  from-string <qr_string>                  Generate QR code from QR string"
    Write-Host "  list-sessions                            List all WhatsApp sessions"
    Write-Host "  help                                     Show this help message"
    Write-Host ""
    Write-Host "Phone Number Format:"
    Write-ColorOutput "Yellow" "  📱 Use phone number WITHOUT the '+' prefix"
    Write-ColorOutput "Yellow" "  ✅ Correct:   6285168671319"
    Write-ColorOutput "Yellow" "  ❌ Incorrect: +6285168671319"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Output <path>                 Output file path (default: auto-generated)"
    Write-Host "  -Format <format>               Image format: png or svg (default: png)"
    Write-Host "  -Size <pixels>                 Image size in pixels (default: 512)"
    Write-Host "  -Margin <margin>               Margin size (default: 2)"
    Write-Host "  -Dir <directory>               Output directory (default: ./qr-codes)"
    Write-Host "  -NoTimestamp                   Don't add timestamp to filename"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\qr-generator.ps1 generate felix_main"
    Write-Host "  .\qr-generator.ps1 create 6285168671319 felix_indonesia"
    Write-Host "  .\qr-generator.ps1 create-auto 6285168671319"
    Write-Host "  .\qr-generator.ps1 from-string `"2@ABC123...`" -Output whatsapp-qr.png"
    Write-Host "  .\qr-generator.ps1 list-sessions"
    Write-Host ""
}

# Function to check dependencies
function Test-Dependencies {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-ColorOutput "Red" "❌ Error: Node.js is not installed or not in PATH"
        exit 1
    }

    if (-not (Test-Path "generate-qr-image.js")) {
        Write-ColorOutput "Red" "❌ Error: generate-qr-image.js not found in current directory"
        exit 1
    }

    if (-not (Test-Path "package.json")) {
        Write-ColorOutput "Red" "❌ Error: package.json not found. Run 'npm install' first"
        exit 1
    }
}

# Function to create output directory
function New-OutputDirectory {
    param([string]$Directory)
    
    if (-not (Test-Path $Directory)) {
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
        Write-ColorOutput "Blue" "📁 Created directory: $Directory"
    }
}

# Function to generate timestamp
function Get-Timestamp {
    return (Get-Date -Format "yyyyMMdd_HHmmss")
}

# Function to list sessions
function Get-Sessions {
    Write-ColorOutput "Blue" "📋 Fetching WhatsApp sessions..."
    
    try {
        $response = Invoke-RestMethod -Uri "$API_BASE_URL/sessions" -Method GET
        
        Write-Host ""
        Write-Host "📱 WhatsApp Sessions:"
        Write-Host ("=" * 50)
        
        if ($response.Count -eq 0) {
            Write-Host "No sessions found."
        } else {
            for ($i = 0; $i -lt $response.Count; $i++) {
                $session = $response[$i]
                $status = if ($session.isConnected) { "🟢 Connected" } else { "🔴 Disconnected" }
                Write-Host "$($i + 1). ID: $($session.id)"
                $phoneNumber = if ($session.phoneNumber) { $session.phoneNumber } else { 'N/A' }
                Write-Host "   Phone: $phoneNumber"
                Write-Host "   Status: $status"
                Write-Host ""
            }
        }
    }
    catch {
        Write-ColorOutput "Red" "❌ Failed to fetch sessions from API: $($_.Exception.Message)"
        exit 1
    }
}

# Function to get QR code from session
function Get-QRFromSession {
    param([string]$SessionId)
    
    Write-ColorOutput "Blue" "🔍 Fetching QR code for session: $SessionId"
    
    try {
        $response = Invoke-RestMethod -Uri "$API_BASE_URL/sessions/$SessionId/qr" -Method GET
        
        if ($response.qrCode) {
            return $response.qrCode
        } elseif ($response.qr) {
            return $response.qr
        } else {
            Write-ColorOutput "Red" "❌ No QR code found in response"
            exit 1
        }
    }
    catch {
        Write-ColorOutput "Red" "❌ QR code not available for session: $SessionId"
        Write-ColorOutput "Yellow" "💡 Try creating a new session or check if the session exists"
        exit 1
    }
}

# Function to create new session
function New-Session {
    param(
        [string]$PhoneNumber,
        [string]$CustomSessionId
    )
    
    $sessionId = if ($CustomSessionId) { $CustomSessionId } else { "qr_session_$(Get-Timestamp)" }
    
    Write-ColorOutput "Blue" "🆕 Creating new session: $sessionId"
    
    $body = @{
        userId = $sessionId
        phoneNumber = $PhoneNumber
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri "$API_BASE_URL/sessions" -Method POST -Body $body -ContentType "application/json"
        Write-ColorOutput "Green" "✅ Session created successfully: $sessionId"
        Write-ColorOutput "Yellow" "⏳ Waiting 5 seconds for QR code generation..."
        Start-Sleep -Seconds 5
        return $sessionId
    }
    catch {
        Write-ColorOutput "Red" "❌ Failed to create session: $($_.Exception.Message)"
        exit 1
    }
}

# Function to generate QR image
function New-QRImage {
    param(
        [string]$QRString,
        [string]$OutputPath,
        [string]$Format,
        [int]$Size,
        [int]$Margin
    )
    
    Write-ColorOutput "Blue" "🎨 Generating QR code image..."
    
    try {
        $result = & node generate-qr-image.js $QRString $OutputPath $Format $Size $Margin
        
        if ($LASTEXITCODE -eq 0) {
            Write-ColorOutput "Green" "✅ QR code image generated successfully: $OutputPath"
            
            if (Test-Path $OutputPath) {
                $fileInfo = Get-Item $OutputPath
                $fileSize = [math]::Round($fileInfo.Length / 1KB, 2)
                Write-ColorOutput "Cyan" "📏 File size: $fileSize KB"
            }
            return $true
        } else {
            Write-ColorOutput "Red" "❌ Failed to generate QR code image"
            return $false
        }
    }
    catch {
        Write-ColorOutput "Red" "❌ Failed to generate QR code image: $($_.Exception.Message)"
        return $false
    }
}

# Function to generate output filename
function Get-OutputFilename {
    param(
        [string]$SessionId,
        [string]$Format,
        [string]$OutputDir,
        [bool]$UseTimestamp
    )
    
    $baseName = if ($SessionId) { "whatsapp-qr-$SessionId" } else { "whatsapp-qr-manual" }
    
    if ($UseTimestamp) {
        $timestamp = Get-Timestamp
        return "$OutputDir/$baseName-$timestamp.$Format"
    } else {
        return "$OutputDir/$baseName.$Format"
    }
}

# Function to validate phone number
function Test-PhoneNumber {
    param([string]$PhoneNumber)
    
    if ($PhoneNumber.StartsWith("+")) {
        Write-ColorOutput "Red" "❌ Phone number should NOT include '+' prefix"
        Write-ColorOutput "Yellow" "💡 Use: $($PhoneNumber.Substring(1)) (without +)"
        return $false
    }
    return $true
}

# Main execution
if (-not $Command -or $Command -eq "help") {
    Show-Usage
    exit 0
}

# Check dependencies
Test-Dependencies

# Execute command
switch ($Command.ToLower()) {
    "list-sessions" {
        Get-Sessions
    }
    
    "generate" {
        if (-not $Arg1) {
            Write-ColorOutput "Red" "❌ Session ID is required for generate command"
            exit 1
        }
        
        New-OutputDirectory $Dir
        
        if (-not $Output) {
            $Output = Get-OutputFilename $Arg1 $Format $Dir (-not $NoTimestamp)
        }
        
        $qrCode = Get-QRFromSession $Arg1
        $success = New-QRImage $qrCode $Output $Format $Size $Margin
        
        if (-not $success) { exit 1 }
    }
    
    "create" {
        if (-not $Arg1) {
            Write-ColorOutput "Red" "❌ Phone number is required for create command"
            Write-ColorOutput "Yellow" "💡 Usage: .\qr-generator.ps1 create <phone_number> <session_id>"
            Write-ColorOutput "Yellow" "💡 Example: .\qr-generator.ps1 create 6285168671319 felix_indonesia"
            exit 1
        }
        
        if (-not $Arg2) {
            Write-ColorOutput "Red" "❌ Session ID is required for create command"
            Write-ColorOutput "Yellow" "💡 Usage: .\qr-generator.ps1 create <phone_number> <session_id>"
            Write-ColorOutput "Yellow" "💡 Example: .\qr-generator.ps1 create 6285168671319 felix_indonesia"
            exit 1
        }
        
        if (-not (Test-PhoneNumber $Arg1)) { exit 1 }
        
        New-OutputDirectory $Dir
        
        $createdSessionId = New-Session $Arg1 $Arg2
        
        if (-not $Output) {
            $Output = Get-OutputFilename $createdSessionId $Format $Dir (-not $NoTimestamp)
        }
        
        $qrCode = Get-QRFromSession $createdSessionId
        $success = New-QRImage $qrCode $Output $Format $Size $Margin
        
        if (-not $success) { exit 1 }
    }
    
    "create-auto" {
        if (-not $Arg1) {
            Write-ColorOutput "Red" "❌ Phone number is required for create-auto command"
            Write-ColorOutput "Yellow" "💡 Usage: .\qr-generator.ps1 create-auto <phone_number>"
            Write-ColorOutput "Yellow" "💡 Example: .\qr-generator.ps1 create-auto 6285168671319"
            exit 1
        }
        
        if (-not (Test-PhoneNumber $Arg1)) { exit 1 }
        
        New-OutputDirectory $Dir
        
        $createdSessionId = New-Session $Arg1
        
        if (-not $Output) {
            $Output = Get-OutputFilename $createdSessionId $Format $Dir (-not $NoTimestamp)
        }
        
        $qrCode = Get-QRFromSession $createdSessionId
        $success = New-QRImage $qrCode $Output $Format $Size $Margin
        
        if (-not $success) { exit 1 }
    }
    
    "from-string" {
        if (-not $Arg1) {
            Write-ColorOutput "Red" "❌ QR string is required for from-string command"
            exit 1
        }
        
        New-OutputDirectory $Dir
        
        if (-not $Output) {
            $Output = Get-OutputFilename "" $Format $Dir (-not $NoTimestamp)
        }
        
        $success = New-QRImage $Arg1 $Output $Format $Size $Margin
        
        if (-not $success) { exit 1 }
    }
    
    default {
        Write-ColorOutput "Red" "❌ Unknown command: $Command"
        Show-Usage
        exit 1
    }
}

Write-ColorOutput "Green" "🎉 Process completed successfully!"
Write-ColorOutput "Cyan" "📱 You can now scan the QR code with WhatsApp to connect your device."
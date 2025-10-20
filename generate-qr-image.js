#!/usr/bin/env node

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

/**
 * Local QR Code Image Generator
 * 
 * This script generates QR code images from QR code strings.
 * You can use it to convert the QR code string from your WhatsApp API into an image file.
 */

class LocalQRGenerator {
  /**
   * Generate a PNG image from QR code string
   * @param {string} qrString - The QR code string
   * @param {string} outputPath - Output file path (optional)
   * @param {object} options - QR code options
   */
  static async generatePNG(qrString, outputPath = null, options = {}) {
    try {
      const defaultOptions = {
        width: 512,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      };

      const qrOptions = { ...defaultOptions, ...options };
      
      // Generate the QR code as a buffer
      const buffer = await QRCode.toBuffer(qrString, qrOptions);
      
      // If no output path specified, generate one
      if (!outputPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        outputPath = `qr-code-${timestamp}.png`;
      }
      
      // Ensure the output directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Write the buffer to file
      fs.writeFileSync(outputPath, buffer);
      
      console.log(`✅ QR code image generated successfully: ${outputPath}`);
      console.log(`📏 Image size: ${qrOptions.width}x${qrOptions.width} pixels`);
      
      return outputPath;
    } catch (error) {
      console.error('❌ Error generating QR code image:', error.message);
      throw error;
    }
  }

  /**
   * Generate an SVG image from QR code string
   * @param {string} qrString - The QR code string
   * @param {string} outputPath - Output file path (optional)
   * @param {object} options - QR code options
   */
  static async generateSVG(qrString, outputPath = null, options = {}) {
    try {
      const defaultOptions = {
        width: 512,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      };

      const qrOptions = { ...defaultOptions, ...options };
      
      // Generate the QR code as SVG string
      const svgString = await QRCode.toString(qrString, { 
        type: 'svg',
        ...qrOptions 
      });
      
      // If no output path specified, generate one
      if (!outputPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        outputPath = `qr-code-${timestamp}.svg`;
      }
      
      // Ensure the output directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Write the SVG to file
      fs.writeFileSync(outputPath, svgString);
      
      console.log(`✅ QR code SVG generated successfully: ${outputPath}`);
      
      return outputPath;
    } catch (error) {
      console.error('❌ Error generating QR code SVG:', error.message);
      throw error;
    }
  }
}

// CLI functionality
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
🔧 Local QR Code Image Generator

Usage:
  node generate-qr-image.js <qr_string> [output_path] [format] [width] [margin]

Arguments:
  qr_string    - The QR code string to convert to image
  output_path  - Output file path (optional, auto-generated if not provided)
  format       - Image format: 'png' or 'svg' (default: 'png')
  width        - Image width in pixels (default: 512)
  margin       - Margin size (default: 2)

Examples:
  # Generate PNG with default settings
  node generate-qr-image.js "your-qr-code-string-here"
  
  # Generate PNG with custom path
  node generate-qr-image.js "your-qr-code-string-here" "./qr-codes/my-qr.png"
  
  # Generate SVG with custom size
  node generate-qr-image.js "your-qr-code-string-here" "./qr-codes/my-qr.svg" "svg" 1024 4
  
  # Generate PNG with custom size
  node generate-qr-image.js "your-qr-code-string-here" "./qr-codes/my-qr.png" "png" 256 1

📝 Note: You can get the QR code string from your WhatsApp API:
  GET http://34.121.26.54:3000/api/sessions/your_session_id/qr
`);
    process.exit(0);
  }

  const [qrString, outputPath, format = 'png', width = 512, margin = 2] = args;
  
  const options = {
    width: parseInt(width),
    margin: parseInt(margin)
  };

  (async () => {
    try {
      if (format.toLowerCase() === 'svg') {
        await LocalQRGenerator.generateSVG(qrString, outputPath, options);
      } else {
        await LocalQRGenerator.generatePNG(qrString, outputPath, options);
      }
    } catch (error) {
      console.error('❌ Failed to generate QR code image:', error.message);
      process.exit(1);
    }
  })();
}

module.exports = LocalQRGenerator;
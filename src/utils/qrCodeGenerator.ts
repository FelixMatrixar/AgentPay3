import QRCode from 'qrcode';
import { logger } from './logger';

export interface QRCodeOptions {
  width?: number;
  margin?: number;
  color?: {
    dark?: string;
    light?: string;
  };
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
}

export class QRCodeGenerator {
  /**
   * Generate QR code as PNG buffer
   */
  static async generatePNG(text: string, options: QRCodeOptions = {}): Promise<Buffer> {
    try {
      const defaultOptions = {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        errorCorrectionLevel: 'M' as const,
        ...options
      };

      const buffer = await QRCode.toBuffer(text, defaultOptions);
      logger.info(`QR code PNG generated successfully for text length: ${text.length}`);
      return buffer;
    } catch (error) {
      logger.error('Failed to generate QR code PNG:', error);
      throw new Error('Failed to generate QR code image');
    }
  }

  /**
   * Generate QR code as SVG string
   */
  static async generateSVG(text: string, options: QRCodeOptions = {}): Promise<string> {
    try {
      const defaultOptions = {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        errorCorrectionLevel: 'M' as const,
        ...options
      };

      const svg = await QRCode.toString(text, { 
        type: 'svg',
        ...defaultOptions
      });
      logger.info(`QR code SVG generated successfully for text length: ${text.length}`);
      return svg;
    } catch (error) {
      logger.error('Failed to generate QR code SVG:', error);
      throw new Error('Failed to generate QR code SVG');
    }
  }

  /**
   * Generate QR code as Data URL (base64)
   */
  static async generateDataURL(text: string, options: QRCodeOptions = {}): Promise<string> {
    try {
      const defaultOptions = {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        errorCorrectionLevel: 'M' as const,
        ...options
      };

      const dataURL = await QRCode.toDataURL(text, defaultOptions);
      logger.info(`QR code Data URL generated successfully for text length: ${text.length}`);
      return dataURL;
    } catch (error) {
      logger.error('Failed to generate QR code Data URL:', error);
      throw new Error('Failed to generate QR code Data URL');
    }
  }
}
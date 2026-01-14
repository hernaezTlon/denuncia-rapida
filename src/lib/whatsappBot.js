const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const EventEmitter = require('events');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Buenos Aires Ciudad WhatsApp number
const BA_BOT_NUMBER = '5491150500147@c.us';

// Conversation state machine
const STATES = {
  IDLE: 'idle',
  WAITING_MENU: 'waiting_menu',
  WAITING_CATEGORY: 'waiting_category',
  WAITING_SUBCATEGORY: 'waiting_subcategory',
  WAITING_CONFIRM_START: 'waiting_confirm_start',
  WAITING_LOGIN: 'waiting_login',
  WAITING_EMAIL_CONFIRM: 'waiting_email_confirm',
  WAITING_ADDRESS_INPUT: 'waiting_address_input',
  WAITING_ADDRESS_CONFIRM: 'waiting_address_confirm',
  WAITING_CONTEXT_PHOTO: 'waiting_context_photo',
  WAITING_PLATE_PHOTO: 'waiting_plate_photo',
  WAITING_PLATE_CONFIRM: 'waiting_plate_confirm',
  WAITING_DATE: 'waiting_date',
  WAITING_DESCRIPTION: 'waiting_description',
  WAITING_FINAL_CONFIRM: 'waiting_final_confirm',
  COMPLETED: 'completed',
  ERROR: 'error'
};

class WhatsAppBot extends EventEmitter {
  constructor() {
    super();
    
    this.client = null;
    this.isReady = false;
    this.currentReport = null;
    this.state = STATES.IDLE;
    this.loginUrl = null;
  }
  
  async initialize() {
    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(process.env.HOME || process.env.USERPROFILE, '.denuncia-rapida-session')
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });
    
    // QR Code for first-time login
    this.client.on('qr', (qr) => {
      console.log('QR Code received, scan to login:');
      qrcode.generate(qr, { small: true });
      this.emit('qr', qr);
    });
    
    // Ready
    this.client.on('ready', () => {
      console.log('WhatsApp client is ready!');
      this.isReady = true;
      this.emit('ready');
    });
    
    // Authentication failure
    this.client.on('auth_failure', (error) => {
      console.error('WhatsApp auth failure:', error);
      this.emit('auth-failure', error);
    });
    
    // Incoming messages
    this.client.on('message', async (message) => {
      // Only process messages from BA bot
      if (message.from === BA_BOT_NUMBER) {
        await this.handleBotResponse(message);
      }
    });
    
    await this.client.initialize();
  }
  
  /**
   * Start a new parking violation report
   */
  async submitReport(reportData) {
    if (!this.isReady) {
      throw new Error('WhatsApp not ready');
    }
    
    this.currentReport = {
      ...reportData,
      ticketNumber: null,
      startedAt: new Date(),
      logs: []
    };
    
    this.state = STATES.WAITING_MENU;
    
    // Start the conversation
    await this.sendMessage('Denuncia vial');
    
    // Return a promise that resolves when the report is completed
    return new Promise((resolve, reject) => {
      this.reportResolve = resolve;
      this.reportReject = reject;
      
      // Timeout after 5 minutes
      this.reportTimeout = setTimeout(() => {
        this.state = STATES.ERROR;
        reject(new Error('Report timed out'));
      }, 5 * 60 * 1000);
    });
  }
  
  /**
   * Handle responses from the BA bot
   */
  async handleBotResponse(message) {
    const text = message.body;
    this.log(`Bot: ${text.substring(0, 100)}...`);
    this.emit('message', { from: 'bot', text });
    
    // Parse bot message and respond based on current state
    switch (this.state) {
      case STATES.WAITING_MENU:
        // Bot shows main menu, we look for "Vehículos" option
        if (text.includes('Vehículos') || text.includes('Autos mal estacionados')) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_CATEGORY;
        }
        break;
        
      case STATES.WAITING_CATEGORY:
        // Bot shows vehicle options
        if (text.includes('Auto mal estacionado')) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_SUBCATEGORY;
        }
        break;
        
      case STATES.WAITING_SUBCATEGORY:
        // Bot asks if we have everything ready
        if (text.includes('Si tenés todo')) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_CONFIRM_START;
        }
        break;
        
      case STATES.WAITING_CONFIRM_START:
        // Bot asks for login
        if (text.includes('iniciá sesión') || text.includes('botm.cc')) {
          // Extract login URL
          const urlMatch = text.match(/botm\.cc\/\w+/);
          if (urlMatch) {
            this.loginUrl = `https://${urlMatch[0]}`;
            this.emit('login-required', this.loginUrl);
          }
          this.state = STATES.WAITING_LOGIN;
        }
        break;
        
      case STATES.WAITING_LOGIN:
        // Bot confirms login successful
        if (text.includes('ya estás en miBA') || text.includes('Listo')) {
          this.state = STATES.WAITING_EMAIL_CONFIRM;
        }
        break;
        
      case STATES.WAITING_EMAIL_CONFIRM:
        // Bot shows email and asks to confirm
        if (text.includes('mail') && (text.includes('A. Está bien') || text.includes('Está bien'))) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_ADDRESS_INPUT;
        }
        break;
        
      case STATES.WAITING_ADDRESS_INPUT:
        // Bot asks for address
        if (text.includes('dirección exacta') || text.includes('esquina')) {
          await this.delay(500);
          await this.sendMessage(this.currentReport.address);
          this.state = STATES.WAITING_ADDRESS_CONFIRM;
        }
        break;
        
      case STATES.WAITING_ADDRESS_CONFIRM:
        // Bot shows address and asks to confirm
        if (text.includes('Anoté esta dirección') && text.includes('A. Está bien')) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_CONTEXT_PHOTO;
        } else if (text.includes('Mandame una foto') && text.includes('dónde está estacionado')) {
          // Already at photo step
          await this.delay(500);
          await this.sendPhoto(this.currentReport.contextPhotoPath);
          this.state = STATES.WAITING_PLATE_PHOTO;
        }
        break;
        
      case STATES.WAITING_CONTEXT_PHOTO:
        // Bot asks for context photo
        if (text.includes('foto') && text.includes('dónde está')) {
          await this.delay(500);
          await this.sendPhoto(this.currentReport.contextPhotoPath);
          this.state = STATES.WAITING_PLATE_PHOTO;
        }
        break;
        
      case STATES.WAITING_PLATE_PHOTO:
        // Bot asks for plate photo
        if (text.includes('foto') && text.includes('patente')) {
          await this.delay(500);
          await this.sendPhoto(this.currentReport.platePhotoPath);
          this.state = STATES.WAITING_PLATE_CONFIRM;
        }
        break;
        
      case STATES.WAITING_PLATE_CONFIRM:
        // Bot shows detected plate
        if (text.includes('Anoté esta patente') && text.includes('A. Sí')) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_DATE;
        }
        break;
        
      case STATES.WAITING_DATE:
        // Bot asks for date
        if (text.includes('Qué día viste') || text.includes('fecha')) {
          await this.delay(500);
          // Send "Ahora" if recent, otherwise send formatted date
          const response = this.currentReport.isRecent ? 'Ahora' : this.currentReport.date;
          await this.sendMessage(response);
          this.state = STATES.WAITING_DESCRIPTION;
        }
        break;
        
      case STATES.WAITING_DESCRIPTION:
        // Bot asks for description
        if (text.includes('qué está pasando') || text.includes('un solo mensaje')) {
          await this.delay(500);
          await this.sendMessage(this.currentReport.description);
          this.state = STATES.WAITING_FINAL_CONFIRM;
        }
        break;
        
      case STATES.WAITING_FINAL_CONFIRM:
        // Bot asks for final confirmation
        if (text.includes('A. Seguir')) {
          await this.delay(500);
          await this.sendMessage('A');
        } else if (text.includes('número de trámite')) {
          // Extract ticket number
          const ticketMatch = text.match(/\d{8,}\/\d+/);
          if (ticketMatch) {
            this.currentReport.ticketNumber = ticketMatch[0];
          }
          this.state = STATES.COMPLETED;
          this.completeReport();
        }
        break;
    }
  }
  
  /**
   * Send a text message to the BA bot
   */
  async sendMessage(text) {
    this.log(`Sending: ${text}`);
    await this.client.sendMessage(BA_BOT_NUMBER, text);
  }
  
  /**
   * Send a photo to the BA bot
   */
  async sendPhoto(filePath) {
    this.log(`Sending photo: ${filePath}`);
    const media = MessageMedia.fromFilePath(filePath);
    await this.client.sendMessage(BA_BOT_NUMBER, media);
  }
  
  /**
   * Complete the report
   */
  completeReport() {
    clearTimeout(this.reportTimeout);
    
    const result = {
      success: true,
      ticketNumber: this.currentReport.ticketNumber,
      duration: new Date() - this.currentReport.startedAt,
      logs: this.currentReport.logs
    };
    
    this.emit('report-completed', result);
    
    if (this.reportResolve) {
      this.reportResolve(result);
    }
    
    this.currentReport = null;
    this.state = STATES.IDLE;
  }
  
  /**
   * Log a message
   */
  log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    
    if (this.currentReport) {
      this.currentReport.logs.push(logEntry);
    }
  }
  
  /**
   * Helper delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get current state
   */
  getState() {
    return this.state;
  }
  
  /**
   * Destroy client
   */
  async destroy() {
    if (this.client) {
      await this.client.destroy();
    }
  }
}

module.exports = { WhatsAppBot, STATES };

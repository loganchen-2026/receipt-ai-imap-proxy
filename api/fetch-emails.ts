/**
 * @file api/fetch-emails.ts
 * @description Vercel 无状态 IMAP 代理 - 阅后即焚翻译官
 * 严格遵守"云端零落盘、绝对隐私"原则
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { simpleParser } from 'mailparser';
import { connect } from 'imap-simple';

export interface ThreeDMatchRule {
  platform_name: string;
  from: string;
  subject: string;
  body_contains: string;
  enabled: boolean;
}

export interface FetchEmailsRequest {
  imapConfig: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
  };
  searchRules: ThreeDMatchRule[];
  lastProcessedUid?: number;
  maxFetchCount?: number;
}

export interface FetchEmailsResponse {
  success: boolean;
  emails: EmailData[];
  error?: string;
  lastUid?: number;
}

export interface EmailData {
  uid: number;
  subject: string;
  from: string;
  date: string;
  platform_name?: string;
  attachments: AttachmentData[];
}

export interface AttachmentData {
  filename: string;
  fileType: string;
  base64Data: string;
  size: number;
}

function safeString(value: any): string {
  return (value && typeof value === 'string') ? value.trim() : '';
}

function safeBool(value: any): boolean {
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  return false;
}

function detectFileType(filename: string, contentType: string): string {
  const lowerFilename = (filename || '').toLowerCase();
  if (lowerFilename.endsWith('.pdf')) return 'pdf';
  if (lowerFilename.endsWith('.html') || lowerFilename.endsWith('.htm')) return 'html';
  if ((contentType || '').includes('pdf')) return 'pdf';
  if ((contentType || '').includes('html')) return 'html';
  return 'unknown';
}

function buildSearchCriteria(searchRules: ThreeDMatchRule[], lastProcessedUid?: number): any[] {
  const criteria: any[] = ['UNSEEN'];
  if (lastProcessedUid && lastProcessedUid > 0) {
    criteria.push(['UID', `${lastProcessedUid + 1}:*`]);
  }
  const defaultSinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  criteria.push(['SINCE', defaultSinceDate]);
  
  console.log('[IMAP Proxy] searchRules:', JSON.stringify(searchRules));
  const enabledRules = (searchRules || []).filter(rule => safeBool(rule.enabled));
  console.log('[IMAP Proxy] enabledRules count:', enabledRules.length);
  
  const validFromRules = enabledRules.filter(rule => {
    const from = safeString(rule.from);
    return from !== '';
  });
  const validSubjectRules = enabledRules.filter(rule => {
    const subject = safeString(rule.subject);
    return subject !== '';
  });
  console.log('[IMAP Proxy] validFromRules:', validFromRules.length, 'validSubjectRules:', validSubjectRules.length);
  
  if (validFromRules.length > 0) {
    const fromSet = new Set(validFromRules.map(rule => safeString(rule.from)));
    const fromConditions = Array.from(fromSet).map(from => ['FROM', from]);
    if (fromConditions.length > 1) {
      criteria.push(['OR', ...fromConditions.flat()]);
    } else {
      criteria.push(...fromConditions[0]);
    }
  }
  
  if (validSubjectRules.length > 0) {
    const subjectSet = new Set(validSubjectRules.map(rule => safeString(rule.subject)));
    const subjectConditions = Array.from(subjectSet).map(subject => ['SUBJECT', subject]);
    if (subjectConditions.length > 1) {
      criteria.push(['OR', ...subjectConditions.flat()]);
    } else {
      criteria.push(...subjectConditions[0]);
    }
  }
  
  return criteria;
}

function matchesThreeDConditions(emailFrom: string, emailSubject: string, emailBody: string, rules: ThreeDMatchRule[]): { matched: boolean; platformName?: string } {
  const enabledRules = (rules || []).filter(rule => safeBool(rule.enabled));
  
  if (enabledRules.length === 0) {
    return { matched: true, platformName: '连通性测试' };
  }
  
  const matchedRule = enabledRules.find(rule => {
    const ruleFrom = safeString(rule.from);
    const ruleSubject = safeString(rule.subject);
    const ruleBody = safeString(rule.body_contains);
    
    const fromMatch = ruleFrom === '' || (emailFrom || '').toLowerCase().includes(ruleFrom.toLowerCase());
    const subjectMatch = ruleSubject === '' || (emailSubject || '').toLowerCase().includes(ruleSubject.toLowerCase());
    const bodyMatch = ruleBody === '' || (emailBody || '').toLowerCase().includes(ruleBody.toLowerCase());
    
    return fromMatch && subjectMatch && bodyMatch;
  });
  
  if (matchedRule) {
    return { matched: true, platformName: matchedRule.platform_name };
  }
  return { matched: false };
}

function extractEmailBody(parsedMail: any): string {
  if (parsedMail.text) return parsedMail.text;
  if (parsedMail.html) {
    return parsedMail.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function findAttachmentParts(struct: any, parts: any[] = []): any[] {
  if (struct.parts) {
    for (const part of struct.parts) {
      findAttachmentParts(part, parts);
    }
  }
  if (struct.disposition && struct.disposition.type !== 'inline') {
    parts.push(struct);
  }
  if (struct.disposition?.filename && !struct.disposition.type) {
    parts.push(struct);
  }
  return parts;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Only POST requests are supported.' });
  }
  if (!req.body) {
    return res.status(400).json({ success: false, error: 'Request body is required.' });
  }

  const body = req.body as FetchEmailsRequest;
  const imapConfig = body.imapConfig;
  const searchRules = body.searchRules || [];
  const lastProcessedUid = body.lastProcessedUid;
  const maxFetchCount = body.maxFetchCount || 5;
  
  if (!imapConfig || !imapConfig.host || !imapConfig.user || !imapConfig.password) {
    return res.status(400).json({ success: false, error: 'Invalid IMAP configuration.' });
  }

  let connection: any = null;
  
  try {
    console.log(`[IMAP Proxy] Connecting to ${imapConfig.host} for user ${imapConfig.user}`);
    
    connection = await connect({
      imap: {
        host: imapConfig.host,
        port: imapConfig.port || 993,
        user: imapConfig.user,
        password: imapConfig.password,
        tls: imapConfig.tls !== false,
        authTimeout: 30000,
        connTimeout: 30000,
      }
    });
    
    console.log('[IMAP Proxy] Connected successfully');
    
    await connection.openBox('INBOX');
    const searchCriteria = buildSearchCriteria(searchRules, lastProcessedUid);
    console.log('[IMAP Proxy] 初筛条件:', searchCriteria);
    
    const messages = await connection.search(searchCriteria, { bodies: ['HEADER', 'TEXT'], struct: true });
    console.log(`[IMAP Proxy] 初筛找到 ${messages.length} 封邮件，最大处理数: ${maxFetchCount}`);
    
    const emailResults: EmailData[] = [];
    let maxUid = lastProcessedUid || 0;
    const sortedMessages = messages.sort((a: any, b: any) => b.attributes.uid - a.attributes.uid);
    
    let processedCount = 0;
    for (const message of sortedMessages) {
      if (processedCount >= maxFetchCount) break;
      
      try {
        const uid = message.attributes.uid;
        const subject = message.parts.filter((part: any) => part.which === 'HEADER')[0]?.body?.subject?.[0] || 'No Subject';
        const from = message.parts.filter((part: any) => part.which === 'HEADER')[0]?.body?.from?.[0] || 'Unknown';
        const date = message.parts.filter((part: any) => part.which === 'HEADER')[0]?.body?.date?.[0] || new Date().toISOString();
        
        if (uid > maxUid) maxUid = uid;
        
        let emailBody = '';
        try {
          const messageData = await connection.getPartData(message);
          const parsedMail = await simpleParser(messageData);
          emailBody = extractEmailBody(parsedMail);
        } catch (error) { console.warn('[IMAP Proxy] 解析邮件正文失败:', error); }
        
        const matchResult = matchesThreeDConditions(from, subject, emailBody, searchRules);
        
        if (!matchResult.matched) {
          try { await connection.addFlags(uid, '\\Seen'); } catch (e) {}
          continue;
        }
        
        const attachments: AttachmentData[] = [];
        if (message.attributes.struct) {
          const attachmentParts = findAttachmentParts(message.attributes.struct);
          for (const part of attachmentParts) {
            try {
              const partData = await connection.getPartData(message, part);
              const filename = part.disposition?.filename || part.type || 'unknown';
              const fileType = detectFileType(filename, part.type);
              if (fileType === 'pdf' || fileType === 'html') {
                const base64Data = Buffer.from(partData).toString('base64');
                attachments.push({ filename, fileType, base64Data, size: base64Data.length });
              }
            } catch (error) { console.warn('[IMAP Proxy] 提取附件失败:', error); }
          }
        }
        
        if (attachments.length > 0) {
          emailResults.push({ uid, subject, from, date, platform_name: matchResult.platformName, attachments });
        }
        
        try { await connection.addFlags(uid, '\\Seen'); } catch (e) {}
        processedCount++;
        
      } catch (error) { console.error('[IMAP Proxy] 处理邮件失败:', error); }
    }
    
    res.status(200).json({ success: true, emails: emailResults, lastUid: maxUid });
    
  } catch (error: any) {
    console.error('[IMAP Proxy] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error occurred' });
  } finally {
    if (connection) {
      try { await connection.logout(); } catch (e) {}
    }
  }
}

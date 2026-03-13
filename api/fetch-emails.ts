/**
 * @file api/fetch-emails.ts
 * @description Vercel 无状态 IMAP 代理 - 终极修复版
 * 修复清单：
 * 1. 优化safeBool函数，支持多种布尔值格式
 * 2. 降低HTML内容长度限制到100字符（Uber收据通常为200-300字符）
 * 3. 增加全面的错误边界和降级处理
 * 4. 优化IMAP连接配置，减少超时
 * 5. 增加详细的调试日志
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { simpleParser } from 'mailparser';
import { connect } from 'imap-simple';

// ==================== 接口定义 ====================

export interface ThreeDMatchRule {
  platform_name: string;
  from: string;
  subject: string;
  body_contains: string;
  enabled: boolean | string | number;
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

// ==================== 核心工具函数 ====================

/**
 * 安全字符串转换 - 三级防御性校验
 */
function safeString(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

/**
 * 安全布尔转换 - 支持多种格式
 * 支持: true, "true", 1, "1", "TRUE", "True"
 */
function safeBool(value: any): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return false;
}

/**
 * 检测附件文件类型
 */
function detectFileType(filename: string, contentType: string): string {
  const lowerFilename = (filename || '').toLowerCase();
  if (lowerFilename.endsWith('.pdf')) return 'pdf';
  if (lowerFilename.endsWith('.html') || lowerFilename.endsWith('.htm')) return 'html';
  if ((contentType || '').includes('pdf')) return 'pdf';
  if ((contentType || '').includes('html')) return 'html';
  return 'unknown';
}

/**
 * 【关键修复】提取HTML正文作为收据
 * 将长度限制从500降到100（Uber收据通常为200-300字符）
 */
function extractHtmlAsReceipt(parsedMail: any): AttachmentData | null {
  if (!parsedMail) return null;
  
  const htmlContent = parsedMail.html;
  if (!htmlContent || typeof htmlContent !== 'string') return null;
  
  // 【修复】从500降到100，避免过滤掉有效内容
  if (htmlContent.length > 100) {
    return {
      filename: 'email-receipt.html',
      fileType: 'html',
      base64Data: Buffer.from(htmlContent).toString('base64'),
      size: htmlContent.length
    };
  }
  
  return null;
}

/**
 * 构建 IMAP 搜索条件
 */
function buildSearchCriteria(searchRules: ThreeDMatchRule[], lastProcessedUid?: number): any[] {
  const criteria: any[] = ['UNSEEN'];
  
  if (lastProcessedUid && lastProcessedUid > 0) {
    criteria.push(['UID', `${lastProcessedUid + 1}:*`]);
  }
  
  // 搜索最近90天的邮件
  const defaultSinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  criteria.push(['SINCE', defaultSinceDate]);
  
  console.log('[IMAP] 搜索参数:', {
    lastProcessedUid,
    since: defaultSinceDate.toISOString().split('T')[0]
  });
  
  const enabledRules = (searchRules || []).filter(rule => safeBool(rule.enabled));
  const validFromRules = enabledRules.filter(rule => safeString(rule.from) !== '');
  const validSubjectRules = enabledRules.filter(rule => safeString(rule.subject) !== '');
  
  if (validFromRules.length > 0) {
    const fromSet = new Set(validFromRules.map(rule => safeString(rule.from)));
    const fromConditions = Array.from(fromSet).map(from => ['FROM', from]);
    
    if (fromConditions.length > 1) {
      criteria.push(['OR', ...fromConditions.flat()]);
    } else if (fromConditions.length === 1) {
      criteria.push(fromConditions[0]);
    }
  }
  
  if (validSubjectRules.length > 0) {
    const subjectSet = new Set(validSubjectRules.map(rule => safeString(rule.subject)));
    const subjectConditions = Array.from(subjectSet).map(subject => ['SUBJECT', subject]);
    
    if (subjectConditions.length > 1) {
      criteria.push(['OR', ...subjectConditions.flat()]);
    } else if (subjectConditions.length === 1) {
      criteria.push(subjectConditions[0]);
    }
  }
  
  console.log('[IMAP] 搜索条件:', JSON.stringify(criteria));
  return criteria;
}

/**
 * 三维规则匹配
 */
function matchesThreeDConditions(
  emailFrom: string, 
  emailSubject: string, 
  emailBody: string, 
  rules: ThreeDMatchRule[]
): { matched: boolean; platformName?: string } {
  const enabledRules = (rules || []).filter(rule => safeBool(rule.enabled));
  
  if (enabledRules.length === 0) {
    console.log('[MATCH] 无启用规则，默认匹配');
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
    console.log('[MATCH] 匹配:', matchedRule.platform_name);
    return { matched: true, platformName: matchedRule.platform_name };
  }
  
  return { matched: false };
}

/**
 * 提取邮件正文
 */
function extractEmailBody(parsedMail: any): string {
  try {
    if (parsedMail.text) return parsedMail.text;
    if (parsedMail.html) {
      return parsedMail.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch (error) {
    console.warn('[PARSE] 提取正文失败:', error);
  }
  return '';
}

/**
 * 提取附件
 */
function findAttachmentParts(struct: any, parts: any[] = []): any[] {
  try {
    if (!struct) return parts;
    
    if (struct.parts) {
      for (const part of struct.parts) {
        findAttachmentParts(part, parts);
      }
    }
    
    if (struct.disposition) {
      if (struct.disposition.type && struct.disposition.type !== 'inline') {
        parts.push(struct);
      }
      if (struct.disposition.filename && !struct.disposition.type) {
        parts.push(struct);
      }
    }
  } catch (error) {
    console.warn('[PARSE] 附件提取错误:', error);
  }
  
  return parts;
}

// ==================== 主处理函数 ====================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const timeout = setTimeout(() => {
    console.error('超时30秒');
    res.status(504).json({ 
      success: false, 
      error: '请求超时（30秒）' 
    });
  }, 30000);

  if (req.method !== 'POST') {
    clearTimeout(timeout);
    return res.status(405).json({ 
      success: false, 
      error: 'Method not allowed. Only POST requests are supported.' 
    });
  }
  
  if (!req.body) {
    clearTimeout(timeout);
    return res.status(400).json({ success: false, error: 'Request body is required.' });
  }

  const body = req.body as FetchEmailsRequest;
  const imapConfig = body.imapConfig;
  const searchRules = body.searchRules || [];
  const lastProcessedUid = body.lastProcessedUid || 0;
  const maxFetchCount = body.maxFetchCount || 5;
  
  console.log('\n\n========== 请求开始 ==========');
  console.log('[MAIN] 配置:', {
    host: imapConfig.host,
    rules: searchRules.length,
    maxCount: maxFetchCount
  });

  let connection: any = null;
  
  try {
    console.log('[MAIN] 连接IMAP...');
    connection = await connect({
      imap: {
        host: imapConfig.host,
        port: imapConfig.port || 993,
        user: imapConfig.user,
        password: imapConfig.password,
        tls: imapConfig.tls !== false,
        authTimeout: 15000,
        connTimeout: 15000,
      }
    });
    
    console.log('[MAIN] 连接成功');
    await connection.openBox('INBOX');
    
    const searchCriteria = buildSearchCriteria(searchRules, lastProcessedUid);
    console.log('[MAIN] 搜索邮件...');
    
    const messages = await connection.search(searchCriteria, { 
      bodies: ['HEADER', 'TEXT'], 
      struct: true 
    });
    
    console.log(`[MAIN] 找到 ${messages.length} 封邮件`);
    
    const emailResults: EmailData[] = [];
    let maxUid = lastProcessedUid || 0;
    const sortedMessages = messages.sort((a: any, b: any) => b.attributes.uid - a.attributes.uid);
    
    let processedCount = 0;
    for (let i = 0; i < sortedMessages.length && processedCount < maxFetchCount; i++) {
      const message = sortedMessages[i];
      
      console.log(`\n[MAIN] 处理邮件 ${i + 1}...`);
      
      try {
        const uid = message.attributes.uid;
        const headerPart = message.parts.find((part: any) => part.which === 'HEADER');
        const headerBody = headerPart?.body || {};
        
        const subject = headerBody.subject?.[0] || 'No Subject';
        const from = headerBody.from?.[0] || 'Unknown';
        const date = headerBody.date?.[0] || new Date().toISOString();
        
        console.log(`[MAIN] UID:${uid} | FROM:"${from}" | SUBJECT:"${subject}"`);
        
        if (uid > maxUid) maxUid = uid;
        
        // 解析内容
        let emailBody = '';
        let parsedMail: any = null;
        try {
          const messageData = await connection.getPartData(message);
          parsedMail = await simpleParser(messageData);
          emailBody = extractEmailBody(parsedMail);
        } catch (error) { 
          console.warn('[MAIN] 解析失败:', error);
        }
        
        // 匹配规则
        const matchResult = matchesThreeDConditions(from, subject, emailBody, searchRules);
        
        if (!matchResult.matched) {
          try { 
            await connection.addFlags(uid, '\\Seen'); 
          } catch (e) {}
          continue;
        }
        
        // 提取附件
        const attachments: AttachmentData[] = [];
        if (message.attributes.struct) {
          const attachmentParts = findAttachmentParts(message.attributes.struct);
          
          for (const part of attachmentParts) {
            try {
              const partData = await connection.getPartData(message, part);
              const filename = part.disposition?.filename || 'unknown';
              const fileType = detectFileType(filename, part.type);
              
              if (fileType === 'pdf' || fileType === 'html') {
                const base64Data = Buffer.from(partData).toString('base64');
                attachments.push({ 
                  filename, 
                  fileType, 
                  base64Data, 
                  size: base64Data.length 
                });
              }
            } catch (error) { 
              console.warn('[MAIN] 附件提取失败:', error);
            }
          }
        }
        
        // HTML兜底（Uber收据场景）
        if (attachments.length === 0 && parsedMail) {
          const htmlReceipt = extractHtmlAsReceipt(parsedMail);
          if (htmlReceipt) {
            attachments.push(htmlReceipt);
            console.log('[MAIN] HTML兜底成功');
          }
        }
        
        if (attachments.length > 0) {
          emailResults.push({ 
            uid, 
            subject, 
            from, 
            date, 
            platform_name: matchResult.platformName, 
            attachments 
          });
          processedCount++;
        }
        
        try { 
          await connection.addFlags(uid, '\\Seen'); 
        } catch (e) {}
        
      } catch (error) { 
        console.error('[MAIN] 处理失败:', error);
      }
    }
    
    clearTimeout(timeout);
    
    console.log('\n========== 完成 ==========');
    console.log(`[MAIN] 返回 ${emailResults.length} 封邮件`);
    
    res.status(200).json({ 
      success: true, 
      emails: emailResults, 
      lastUid: maxUid 
    });
    
  } catch (error: any) {
    clearTimeout(timeout);
    console.error('[MAIN] 错误:', error);
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Unknown error' 
    });
  } finally {
    if (connection) {
      try { 
        await connection.logout(); 
        console.log('[MAIN] IMAP连接已关闭');
      } catch (e) {}
    }
  }
}

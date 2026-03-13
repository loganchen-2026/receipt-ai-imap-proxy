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

/**
 * 安全字符串转换 - 三级防御性校验
 */
function safeString(value: any): string {
  if (value === null || value === undefined || typeof value === 'string' && value.trim() === '') {
    return '';
  }
  return String(value).trim();
}

/**
 * 安全布尔转换 - 支持多种格式
 * 修复：支持 true, "true", 1, "1" 等多种格式
 */
function safeBool(value: any): boolean {
  if (value === true || value === 1 || value === 'true' || value === '1') {
    return true;
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
 * 构建 IMAP 搜索条件 - 核心修复
 * 关键改进：严格过滤空字符串，修复 OR 条件嵌套
 */
function buildSearchCriteria(searchRules: ThreeDMatchRule[], lastProcessedUid?: number): any[] {
  const criteria: any[] = ['UNSEEN'];
  
  // 添加 UID 范围条件
  if (lastProcessedUid && lastProcessedUid > 0) {
    criteria.push(['UID', `${lastProcessedUid + 1}:*`]);
  }
  
  // 添加日期范围（30天内）
  const defaultSinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  criteria.push(['SINCE', defaultSinceDate]);
  
  console.log('[IMAP Proxy] 原始搜索规则:', JSON.stringify(searchRules));
  
  // 过滤启用的规则
  const enabledRules = (searchRules || []).filter(rule => safeBool(rule.enabled));
  console.log('[IMAP Proxy] 启用规则数量:', enabledRules.length);
  
  // 双重保险：严格过滤空字符串
  const validFromRules = enabledRules.filter(rule => {
    const from = safeString(rule.from);
    return from !== '';
  });
  
  const validSubjectRules = enabledRules.filter(rule => {
    const subject = safeString(rule.subject);
    return subject !== '';
  });
  
  console.log('[IMAP Proxy] 有效 FROM 规则:', validFromRules.length, '有效 SUBJECT 规则:', validSubjectRules.length);
  
  // 构建 FROM 条件 - 关键修复：避免空字符串
  if (validFromRules.length > 0) {
    const fromSet = new Set(validFromRules.map(rule => safeString(rule.from)));
    const fromConditions = Array.from(fromSet).map(from => ['FROM', from]);
    
    if (fromConditions.length > 1) {
      // 多个 FROM 条件使用 OR
      criteria.push(['OR', ...fromConditions.flat()]);
    } else if (fromConditions.length === 1) {
      // 单个 FROM 条件直接添加
      criteria.push(fromConditions[0]);
    }
  }
  
  // 构建 SUBJECT 条件
  if (validSubjectRules.length > 0) {
    const subjectSet = new Set(validSubjectRules.map(rule => safeString(rule.subject)));
    const subjectConditions = Array.from(subjectSet).map(subject => ['SUBJECT', subject]);
    
    if (subjectConditions.length > 1) {
      criteria.push(['OR', ...subjectConditions.flat()]);
    } else if (subjectConditions.length === 1) {
      criteria.push(subjectConditions[0]);
    }
  }
  
  console.log('[IMAP Proxy] 最终搜索条件:', JSON.stringify(criteria));
  return criteria;
}

/**
 * 三维规则匹配（from + subject + body_contains）
 */
function matchesThreeDConditions(
  emailFrom: string, 
  emailSubject: string, 
  emailBody: string, 
  rules: ThreeDMatchRule[]
): { matched: boolean; platformName?: string } {
  const enabledRules = (rules || []).filter(rule => safeBool(rule.enabled));
  
  // 如果没有启用规则，默认匹配（用于连通性测试）
  if (enabledRules.length === 0) {
    return { matched: true, platformName: '连通性测试' };
  }
  
  // 查找匹配的规则
  const matchedRule = enabledRules.find(rule => {
    const ruleFrom = safeString(rule.from);
    const ruleSubject = safeString(rule.subject);
    const ruleBody = safeString(rule.body_contains);
    
    // 空字符串表示匹配所有
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

/**
 * 提取邮件正文
 */
function extractEmailBody(parsedMail: any): string {
  if (parsedMail.text) return parsedMail.text;
  
  if (parsedMail.html) {
    return parsedMail.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  
  return '';
}

/**
 * 递归查找附件部分
 */
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

/**
 * Vercel API 主处理函数
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      error: 'Method not allowed. Only POST requests are supported.' 
    });
  }
  
  // 验证请求体
  if (!req.body) {
    return res.status(400).json({ success: false, error: 'Request body is required.' });
  }

  const body = req.body as FetchEmailsRequest;
  const imapConfig = body.imapConfig;
  const searchRules = body.searchRules || [];
  const lastProcessedUid = body.lastProcessedUid;
  const maxFetchCount = body.maxFetchCount || 5;
  
  // 验证 IMAP 配置
  if (!imapConfig || !imapConfig.host || !imapConfig.user || !imapConfig.password) {
    return res.status(400).json({ success: false, error: 'Invalid IMAP configuration.' });
  }

  let connection: any = null;
  
  try {
    // 连接 IMAP 服务器
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
    
    // 打开收件箱
    await connection.openBox('INBOX');
    
    // 构建搜索条件
    const searchCriteria = buildSearchCriteria(searchRules, lastProcessedUid);
    
    // 搜索邮件
    const messages = await connection.search(searchCriteria, { 
      bodies: ['HEADER', 'TEXT'], 
      struct: true 
    });
    
    const emailResults: EmailData[] = [];
    let maxUid = lastProcessedUid || 0;
    
    // 按 UID 降序排序（最新的优先）
    const sortedMessages = messages.sort((a: any, b: any) => b.attributes.uid - a.attributes.uid);
    
    let processedCount = 0;
    for (const message of sortedMessages) {
      if (processedCount >= maxFetchCount) break;
      
      try {
        const uid = message.attributes.uid;
        const headerPart = message.parts.find((part: any) => part.which === 'HEADER');
        const headerBody = headerPart?.body || {};
        
        const subject = headerBody.subject?.[0] || 'No Subject';
        const from = headerBody.from?.[0] || 'Unknown';
        const date = headerBody.date?.[0] || new Date().toISOString();
        
        if (uid > maxUid) maxUid = uid;
        
        // 提取邮件正文
        let emailBody = '';
        try {
          const messageData = await connection.getPartData(message);
          const parsedMail = await simpleParser(messageData);
          emailBody = extractEmailBody(parsedMail);
        } catch (error) { 
          console.warn('[IMAP Proxy] 解析邮件正文失败:', error); 
        }
        
        // 检查是否匹配规则
        const matchResult = matchesThreeDConditions(from, subject, emailBody, searchRules);
        
        if (!matchResult.matched) {
          // 不匹配则标记为已读
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
              const filename = part.disposition?.filename || part.type || 'unknown';
              const fileType = detectFileType(filename, part.type);
              
              // 只处理 PDF 和 HTML 文件
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
              console.warn('[IMAP Proxy] 提取附件失败:', error); 
            }
          }
        }
        
        // 只返回有附件的邮件
        if (attachments.length > 0) {
          emailResults.push({ 
            uid, 
            subject, 
            from, 
            date, 
            platform_name: matchResult.platformName, 
            attachments 
          });
        }
        
        // 标记为已读
        try { 
          await connection.addFlags(uid, '\\Seen'); 
        } catch (e) {}
        
        processedCount++;
        
      } catch (error) { 
        console.error('[IMAP Proxy] 处理邮件失败:', error); 
      }
    }
    
    // 返回结果
    res.status(200).json({ 
      success: true, 
      emails: emailResults, 
      lastUid: maxUid 
    });
    
  } catch (error: any) {
    console.error('[IMAP Proxy] 错误:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Unknown error occurred' 
    });
  } finally {
    // 确保连接关闭
    if (connection) {
      try { 
        await connection.logout(); 
      } catch (e) {}
    }
  }
}

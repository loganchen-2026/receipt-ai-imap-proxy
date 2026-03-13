/**
 * @file api/fetch-emails.ts
 * @description Vercel 无状态 IMAP 代理 - 阅后即焚翻译官
 * 严格遵守"云端零落盘、绝对隐私"原则
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { simpleParser } from 'mailparser';
import { connect } from 'imap-simple';

// 多平台规则引擎匹配规则接口
export interface ThreeDMatchRule {
  platform_name: string; // 新增：平台名称标识
  from: string;
  subject: string;
  body_contains: string;
  enabled: boolean;
}

// 请求接口定义
export interface FetchEmailsRequest {
  imapConfig: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
  };
  searchRules: ThreeDMatchRule[]; // 改为三维规则数组
  lastProcessedUid?: number;
  maxFetchCount?: number; // 新增：最大处理邮件数量，防止 Vercel 超时
}

// 响应接口定义
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
  platform_name?: string; // 新增：匹配的平台名称
  attachments: AttachmentData[];
}

export interface AttachmentData {
  filename: string;
  fileType: string;
  base64Data: string;
  size: number;
}

// 邮件内容类型检测
function detectFileType(filename: string, contentType: string): string {
  const lowerFilename = filename.toLowerCase();
  
  if (lowerFilename.endsWith('.pdf')) return 'pdf';
  if (lowerFilename.endsWith('.html') || lowerFilename.endsWith('.htm')) return 'html';
  if (contentType.includes('pdf')) return 'pdf';
  if (contentType.includes('html')) return 'html';
  
  // 常见收据相关的 MIME 类型
  if (contentType.includes('application/pdf')) return 'pdf';
  if (contentType.includes('text/html')) return 'html';
  
  return 'unknown';
}

// 构建 IMAP 初筛搜索条件（仅基于 FROM 和 SUBJECT）
function buildSearchCriteria(searchRules: ThreeDMatchRule[], lastProcessedUid?: number): any[] {
  const criteria: any[] = ['UNSEEN']; // 只处理未读邮件
  
  // UID 增量同步
  if (lastProcessedUid && lastProcessedUid > 0) {
    criteria.push(['UID', `${lastProcessedUid + 1}:*`]);
  }
  
  // 日期过滤 - 默认过去30天
  const defaultSinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  criteria.push(['SINCE', defaultSinceDate]);
  
  // 提取所有启用的规则的 from 和 subject 进行初筛
  const enabledRules = searchRules.filter(rule => rule.enabled);
  const fromSet = new Set(enabledRules.map(rule => rule.from));
  const subjectSet = new Set(enabledRules.map(rule => rule.subject));
  
  // 发件人过滤
  if (fromSet.size > 0) {
    const fromConditions = Array.from(fromSet).map(from => ['FROM', from]);
    if (fromConditions.length > 1) {
      criteria.push(['OR', ...fromConditions.flat()]);
    } else {
      criteria.push(...fromConditions[0]);
    }
  }
  
  // 主题过滤
  if (subjectSet.size > 0) {
    const subjectConditions = Array.from(subjectSet).map(subject => ['SUBJECT', subject]);
    if (subjectConditions.length > 1) {
      criteria.push(['OR', ...subjectConditions.flat()]);
    } else {
      criteria.push(...subjectConditions[0]);
    }
  }
  
  return criteria;
}

// 多平台规则引擎匹配检查（OR 组间，AND 组内）
function matchesThreeDConditions(emailFrom: string, emailSubject: string, emailBody: string, rules: ThreeDMatchRule[]): { matched: boolean; platformName?: string } {
  const enabledRules = rules.filter(rule => rule.enabled);
  
  // 使用 Array.prototype.some() 实现 OR 组间匹配
  const matchedRule = enabledRules.find(rule => {
    // AND 组内匹配：三个条件必须同时满足
    const fromMatch = emailFrom.toLowerCase().includes(rule.from.toLowerCase());
    const subjectMatch = emailSubject.toLowerCase().includes(rule.subject.toLowerCase());
    const bodyMatch = emailBody.toLowerCase().includes(rule.body_contains.toLowerCase());
    
    return fromMatch && subjectMatch && bodyMatch;
  });
  
  if (matchedRule) {
    console.log(`[IMAP Proxy] 多平台规则匹配成功: ${matchedRule.platform_name} | ${matchedRule.from} | ${matchedRule.subject} | ${matchedRule.body_contains}`);
    return { matched: true, platformName: matchedRule.platform_name };
  }
  
  return { matched: false };
}

// 提取邮件正文内容
function extractEmailBody(parsedMail: any): string {
  // 优先使用纯文本正文
  if (parsedMail.text) {
    return parsedMail.text;
  }
  
  // 如果没有纯文本，尝试从HTML中提取文本内容
  if (parsedMail.html) {
    // 简单的HTML标签去除（仅用于关键词匹配）
    return parsedMail.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  
  return '';
}

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
    return res.status(400).json({ 
      success: false, 
      error: 'Request body is required.' 
    });
  }
  
  const { imapConfig, searchRules, lastProcessedUid, maxFetchCount = 5 } = req.body as FetchEmailsRequest;
  
  // 验证配置
  if (!imapConfig || !imapConfig.host || !imapConfig.user || !imapConfig.password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid IMAP configuration. host, user, and password are required.' 
    });
  }
  
  let connection: any = null;
  
  try {
    console.log(`[IMAP Proxy] Connecting to ${imapConfig.host} for user ${imapConfig.user}`);
    
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
    
    console.log('[IMAP Proxy] Connected successfully');
    
    // 打开收件箱
    await connection.openBox('INBOX');
    
    // 构建初筛搜索条件（仅基于 FROM 和 SUBJECT）
    const searchCriteria = buildSearchCriteria(searchRules || [], lastProcessedUid);
    console.log('[IMAP Proxy] 初筛条件:', searchCriteria);
    
    // 搜索邮件（初筛）
    const messages = await connection.search(searchCriteria, {
      bodies: ['HEADER', 'TEXT'],
      struct: true
    });
    
    console.log(`[IMAP Proxy] 初筛找到 ${messages.length} 封邮件，最大处理数: ${maxFetchCount}`);
    
    const emailResults: EmailData[] = [];
    let maxUid = lastProcessedUid || 0;
    
    // 按 UID 降序排序，优先处理最新邮件
    const sortedMessages = messages.sort((a: any, b: any) => b.attributes.uid - a.attributes.uid);
    
    // 处理每封邮件（限制数量防止 Vercel 超时）
    let processedCount = 0;
    for (const message of sortedMessages) {
      if (processedCount >= maxFetchCount) {
        console.log(`[IMAP Proxy] 达到最大处理数 (${maxFetchCount})，停止处理`);
        break;
      }
      
      try {
        const uid = message.attributes.uid;
        const subject = message.parts.filter((part: any) => part.which === 'HEADER')[0]?.body?.subject?.[0] || 'No Subject';
        const from = message.parts.filter((part: any) => part.which === 'HEADER')[0]?.body?.from?.[0] || 'Unknown';
        const date = message.parts.filter((part: any) => part.which === 'HEADER')[0]?.body?.date?.[0] || new Date().toISOString();
        
        console.log(`[IMAP Proxy] 处理邮件 UID:${uid} - 发件人:${from} - 主题:${subject}`);
        
        // 更新最大 UID
        if (uid > maxUid) {
          maxUid = uid;
        }
        
        // 提取邮件正文内容进行三维精筛
        let emailBody = '';
        try {
          // 获取完整的邮件内容进行解析
          const messageData = await connection.getPartData(message);
          const parsedMail = await simpleParser(messageData);
          emailBody = extractEmailBody(parsedMail);
          
          console.log(`[IMAP Proxy] 邮件正文长度: ${emailBody.length} 字符`);
        } catch (error) {
          console.warn(`[IMAP Proxy] 解析邮件正文失败:`, error);
        }
        
        // 多平台规则引擎匹配检查
        const matchResult = matchesThreeDConditions(from, subject, emailBody, searchRules || []);
        
        if (!matchResult.matched) {
          console.log(`[IMAP Proxy] 邮件 UID:${uid} 未通过多平台规则精筛，跳过处理`);
          
          // 即使不匹配，也要标记为已读避免重复处理
          try {
            await connection.addFlags(uid, '\\Seen');
          } catch (error) {
            console.warn(`[IMAP Proxy] Failed to mark email ${uid} as seen:`, error);
          }
          
          continue; // 跳过此邮件
        }
        
        console.log(`[IMAP Proxy] 邮件 UID:${uid} 通过多平台规则精筛，匹配平台: ${matchResult.platformName}，开始提取附件`);
        
        const attachments: AttachmentData[] = [];
        
        // 提取附件（只有通过三维匹配的邮件才处理附件）
        if (message.attributes.struct) {
          const attachmentParts = findAttachmentParts(message.attributes.struct);
          
          for (const part of attachmentParts) {
            try {
              // 获取附件内容
              const partData = await connection.getPartData(message, part);
              
              // 检测文件类型
              const fileType = detectFileType(part.disposition?.filename || part.type, part.type);
              
              // 只处理 PDF 和 HTML 附件
              if (fileType === 'pdf' || fileType === 'html') {
                const base64Data = Buffer.from(partData).toString('base64');
                
                attachments.push({
                  filename: part.disposition?.filename || `attachment_${Date.now()}`,
                  fileType,
                  base64Data,
                  size: base64Data.length
                });
                
                console.log(`[IMAP Proxy] 提取 ${fileType} 附件: ${part.disposition?.filename}`);
              }
            } catch (error) {
              console.warn(`[IMAP Proxy] 提取附件失败:`, error);
            }
          }
        }
        
        // 如果有符合条件的附件，添加到结果中
        if (attachments.length > 0) {
          emailResults.push({
            uid,
            subject,
            from,
            date,
            platform_name: matchResult.platformName, // 添加匹配的平台名称
            attachments
          });
          
          console.log(`[IMAP Proxy] 处理完成: ${subject}，匹配平台: ${matchResult.platformName}，包含 ${attachments.length} 个附件`);
        } else {
          console.log(`[IMAP Proxy] 邮件通过多平台规则匹配但无有效附件，跳过`);
        }
        
        // 标记邮件为已读（避免重复处理）
        try {
          await connection.addFlags(uid, '\\Seen');
        } catch (error) {
          console.warn(`[IMAP Proxy] 标记已读失败:`, error);
        }
        
        processedCount++;
        
      } catch (error) {
        console.error(`[IMAP Proxy] 处理邮件失败:`, error);
      }
    }
    
    // 返回结果
    const response: FetchEmailsResponse = {
      success: true,
      emails: emailResults,
      lastUid: maxUid
    };
    
    console.log(`[IMAP Proxy] Returning ${emailResults.length} emails with attachments`);
    
    res.status(200).json(response);
    
  } catch (error: any) {
    console.error('[IMAP Proxy] Error:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error occurred'
    });
    
  } finally {
    // 强制断开连接 - 阅后即焚
    if (connection) {
      try {
        await connection.logout();
        console.log('[IMAP Proxy] Connection closed');
      } catch (error) {
        console.warn('[IMAP Proxy] Error during logout:', error);
      }
    }
  }
}

// 递归查找附件部分
function findAttachmentParts(struct: any, parts: any[] = []): any[] {
  if (struct.parts) {
    for (const part of struct.parts) {
      findAttachmentParts(part, parts);
    }
  }
  
  // 检测附件（有 disposition 且不是 inline）
  if (struct.disposition && struct.disposition.type !== 'inline') {
    parts.push(struct);
  }
  
  // 检测内嵌附件（有 filename 但无 disposition）
  if (struct.disposition?.filename && !struct.disposition.type) {
    parts.push(struct);
  }
  
  return parts;
}
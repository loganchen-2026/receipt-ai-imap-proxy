/**
 * @file api/fetch-emails.ts
 * @description Vercel 无状态 IMAP 代理 - 终极调试版
 * 调试：打印每一行执行路径，追踪邮件被过滤原因
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
  debug?: any;  // 【新增】调试信息
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

function safeString(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function safeBool(value: any): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
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

function extractHtmlAsReceipt(parsedMail: any): AttachmentData | null {
  console.log('[DEBUG] extractHtmlAsReceipt() 开始');
  console.log('[DEBUG]   parsedMail存在:', !!parsedMail);
  console.log('[DEBUG]   parsedMail.html存在:', !!parsedMail?.html);
  console.log('[DEBUG]   parsedMail.html类型:', typeof parsedMail?.html);
  console.log('[DEBUG]   parsedMail.html长度:', parsedMail?.html?.length || 0);

  if (!parsedMail) {
    console.log('[DEBUG]   ❌ parsedMail为空');
    return null;
  }
  
  const htmlContent = parsedMail.html;
  if (!htmlContent || typeof htmlContent !== 'string') {
    console.log('[DEBUG]   ❌ HTML不存在或不是字符串');
    return null;
  }
  
  console.log('[DEBUG]   HTML长度:', htmlContent.length);
  
  if (htmlContent.length > 100) {
    console.log('[DEBUG]   ✅ HTML符合条件，返回');
    return {
      filename: 'email-receipt.html',
      fileType: 'html',
      base64Data: Buffer.from(htmlContent).toString('base64'),
      size: htmlContent.length
    };
  }
  
  console.log('[DEBUG]   ❌ HTML太短（<=100）');
  return null;
}

function buildSearchCriteria(searchRules: ThreeDMatchRule[], lastProcessedUid?: number): any[] {
  console.log('[DEBUG] buildSearchCriteria() 开始');
  console.log('[DEBUG]   lastProcessedUid:', lastProcessedUid);
  console.log('[DEBUG]   searchRules数量:', searchRules.length);

  const criteria: any[] = ['UNSEEN'];
  
  if (lastProcessedUid && lastProcessedUid > 0) {
    console.log('[DEBUG]   添加UID条件:', `${lastProcessedUid + 1}:*`);
    criteria.push(['UID', `${lastProcessedUid + 1}:*`]);
  }
  
  const defaultSinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  criteria.push(['SINCE', defaultSinceDate]);
  
  console.log('[DEBUG]   添加SINCE条件:', defaultSinceDate.toISOString().split('T')[0]);
  
  const enabledRules = (searchRules || []).filter(rule => safeBool(rule.enabled));
  console.log('[DEBUG]   启用规则数:', enabledRules.length);
  
  const validFromRules = enabledRules.filter(rule => safeString(rule.from) !== '');
  const validSubjectRules = enabledRules.filter(rule => safeString(rule.subject) !== '');
  
  console.log('[DEBUG]   有效FROM规则:', validFromRules.length);
  console.log('[DEBUG]   有效SUBJECT规则:', validSubjectRules.length);
  
  if (validFromRules.length > 0) {
    const fromSet = new Set(validFromRules.map(rule => safeString(rule.from)));
    const fromConditions = Array.from(fromSet).map(from => ['FROM', from]);
    console.log('[DEBUG]   FROM条件:', fromConditions);
    
    if (fromConditions.length > 1) {
      criteria.push(['OR', ...fromConditions.flat()]);
    } else if (fromConditions.length === 1) {
      criteria.push(fromConditions[0]);
    }
  }
  
  if (validSubjectRules.length > 0) {
    const subjectSet = new Set(validSubjectRules.map(rule => safeString(rule.subject)));
    const subjectConditions = Array.from(subjectSet).map(subject => ['SUBJECT', subject]);
    console.log('[DEBUG]   SUBJECT条件:', subjectConditions);
    
    if (subjectConditions.length > 1) {
      criteria.push(['OR', ...subjectConditions.flat()]);
    } else if (subjectConditions.length === 1) {
      criteria.push(subjectConditions[0]);
    }
  }
  
  console.log('[DEBUG]   最终搜索条件:', JSON.stringify(criteria));
  return criteria;
}

function matchesThreeDConditions(
  emailFrom: string, 
  emailSubject: string, 
  emailBody: string, 
  rules: ThreeDMatchRule[]
): { matched: boolean; platformName?: string } {
  console.log('[DEBUG] matchesThreeDConditions() 开始');
  console.log('[DEBUG]   emailFrom:', `"${emailFrom}"`);
  console.log('[DEBUG]   emailSubject:', `"${emailSubject}"`);
  console.log('[DEBUG]   emailBody长度:', emailBody.length);
  console.log('[DEBUG]   rules数量:', rules.length);

  const enabledRules = (rules || []).filter(rule => safeBool(rule.enabled));
  console.log('[DEBUG]   启用规则数:', enabledRules.length);
  
  if (enabledRules.length === 0) {
    console.log('[DEBUG]   ✅ 无规则，默认匹配');
    return { matched: true, platformName: '连通性测试' };
  }
  
  console.log('[DEBUG]   开始逐条检查规则...');
  
  const matchedRule = enabledRules.find((rule, index) => {
    console.log(`[DEBUG]   检查规则 ${index + 1}/${enabledRules.length}: ${rule.platform_name}`);
    
    const ruleFrom = safeString(rule.from);
    const ruleSubject = safeString(rule.subject);
    const ruleBody = safeString(rule.body_contains);
    
    console.log('[DEBUG]     ruleFrom:', `"${ruleFrom}"`);
    console.log('[DEBUG]     ruleSubject:', `"${ruleSubject}"`);
    console.log('[DEBUG]     ruleBody:', `"${ruleBody}"`);
    
    const fromMatch = ruleFrom === '' || (emailFrom || '').toLowerCase().includes(ruleFrom.toLowerCase());
    const subjectMatch = ruleSubject === '' || (emailSubject || '').toLowerCase().includes(ruleSubject.toLowerCase());
    const bodyMatch = ruleBody === '' || (emailBody || '').toLowerCase().includes(ruleBody.toLowerCase());
    
    console.log('[DEBUG]     fromMatch:', fromMatch, `(${ruleFrom} in ${emailFrom})`);
    console.log('[DEBUG]     subjectMatch:', subjectMatch, `(${ruleSubject} in ${emailSubject})`);
    console.log('[DEBUG]     bodyMatch:', bodyMatch, `(${ruleBody} in ${emailBody.substring(0, 50)}...)`);
    
    const allMatch = fromMatch && subjectMatch && bodyMatch;
    console.log('[DEBUG]     结果:', allMatch ? '✅ 匹配' : '❌ 不匹配');
    
    return allMatch;
  });
  
  if (matchedRule) {
    console.log('[DEBUG]   ✅ 找到匹配规则:', matchedRule.platform_name);
    return { matched: true, platformName: matchedRule.platform_name };
  }
  
  console.log('[DEBUG]   ❌ 未匹配任何规则');
  return { matched: false };
}

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
  const requestId = Date.now();
  console.log(`\n\n========== 新请求开始 [${requestId}] ==========`);

  const timeout = setTimeout(() => {
    console.error(`[${requestId}] 请求超时（30秒）`);
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
  
  console.log(`[${requestId}] 配置:`, {
    host: imapConfig.host,
    rules: searchRules.length,
    maxCount: maxFetchCount,
    lastUid: lastProcessedUid
  });

  const debugLog: any[] = [];  // 【新增】收集调试信息

  let connection: any = null;
  
  try {
    console.log(`[${requestId}] 连接IMAP服务器...`);
    const connectStart = Date.now();
    
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
    
    const connectTime = Date.now() - connectStart;
    console.log(`[${requestId}] ✅ IMAP连接成功 (${connectTime}ms)`);
    
    debugLog.push({ step: 'imap_connected', time: connectTime });

    // 打开收件箱
    const boxStart = Date.now();
    await connection.openBox('INBOX');
    const boxTime = Date.now() - boxStart;
    console.log(`[${requestId}] ✅ 打开收件箱 (${boxTime}ms)`);
    
    debugLog.push({ step: 'box_opened', time: boxTime });

    // 构建搜索条件
    console.log(`[${requestId}] 构建搜索条件...`);
    const searchCriteria = buildSearchCriteria(searchRules, lastProcessedUid);
    debugLog.push({ step: 'criteria_built', criteria: searchCriteria });

    // 搜索邮件
    console.log(`[${requestId}] 搜索邮件...`);
    const searchStart = Date.now();
    
    const messages = await connection.search(searchCriteria, { 
      bodies: ['HEADER', 'TEXT'], 
      struct: true 
    });
    
    const searchTime = Date.now() - searchStart;
    console.log(`[${requestId}] ✅ 搜索完成！找到 ${messages.length} 封邮件 (${searchTime}ms)`);
    
    debugLog.push({ 
      step: 'search_completed', 
      time: searchTime, 
      foundCount: messages.length 
    });

    const emailResults: EmailData[] = [];
    let maxUid = lastProcessedUid || 0;
    const sortedMessages = messages.sort((a: any, b: any) => b.attributes.uid - a.attributes.uid);
    
    console.log(`[${requestId}] 按UID降序排序，准备处理 ${Math.min(sortedMessages.length, maxFetchCount)} 封邮件`);
    
    let processedCount = 0;
    for (let i = 0; i < sortedMessages.length && processedCount < maxFetchCount; i++) {
      const message = sortedMessages[i];
      const mailDebug: any = { mailIndex: i + 1, uid: message.attributes.uid };
      
      console.log(`\n[${requestId}] ----- 开始处理第 ${i + 1} 封邮件 -----`);
      console.log(`[${requestId}] UID: ${message.attributes.uid}`);
      
      try {
        // 提取邮件头
        const uid = message.attributes.uid;
        const headerPart = message.parts.find((part: any) => part.which === 'HEADER');
        const headerBody = headerPart?.body || {};
        
        const subject = headerBody.subject?.[0] || 'No Subject';
        const from = headerBody.from?.[0] || 'Unknown';
        const date = headerBody.date?.[0] || new Date().toISOString();
        
        mailDebug.header = { subject, from, date };
        
        console.log(`[${requestId}] 发件人: "${from}"`);
        console.log(`[${requestId}] 主题: "${subject}"`);
        console.log(`[${requestId}] 日期: ${date}`);
        
        if (uid > maxUid) maxUid = uid;
        
        // 解析邮件内容
        console.log(`[${requestId}] 开始解析邮件内容...`);
        let emailBody = '';
        let parsedMail: any = null;
        try {
          const parseStart = Date.now();
          const messageData = await connection.getPartData(message);
          parsedMail = await simpleParser(messageData);
          emailBody = extractEmailBody(parsedMail);
          mailDebug.parsed = { 
            hasText: !!parsedMail.text, 
            hasHtml: !!parsedMail.html,
            htmlLength: parsedMail.html?.length || 0,
            bodyLength: emailBody.length
          };
          console.log(`[${requestId}] ✅ 正文解析完成 (${emailBody.length} 字符, ${Date.now() - parseStart}ms)`);
        } catch (error) { 
          console.warn(`[${requestId}] ❌ 解析邮件正文失败:`, error);
          mailDebug.parseError = error.message;
        }
        
        // 规则匹配
        console.log(`[${requestId}] 开始规则匹配检查...`);
        const matchStart = Date.now();
        const matchResult = matchesThreeDConditions(from, subject, emailBody, searchRules);
        mailDebug.match = {
          matched: matchResult.matched,
          platformName: matchResult.platformName,
          time: Date.now() - matchStart
        };
        
        console.log(`[${requestId}] 匹配结果: ${matchResult.matched ? '✅ 匹配' : '❌ 不匹配'} (${Date.now() - matchStart}ms)`);
        
        if (!matchResult.matched) {
          console.log(`[${requestId}] 规则不匹配，跳过此邮件`);
          mailDebug.skippedReason = 'rule_not_matched';
          debugLog.push(mailDebug);
          
          try { 
            await connection.addFlags(uid, '\\Seen'); 
            console.log(`[${requestId}] 已标记为已读 UID:${uid}`);
          } catch (e) {
            console.warn(`[${requestId}] 标记已读失败:`, e);
          }
          continue;
        }
        
        // 提取附件
        console.log(`[${requestId}] 开始提取附件...`);
        const attachments: AttachmentData[] = [];
        mailDebug.attachment = { foundParts: 0, extracted: 0, types: [] };
        
        if (message.attributes.struct) {
          console.log(`[${requestId}] 邮件有struct结构`);
          const attachmentParts = findAttachmentParts(message.attributes.struct);
          mailDebug.attachment.foundParts = attachmentParts.length;
          console.log(`[${requestId}] 找到 ${attachmentParts.length} 个潜在附件`);
          
          for (let j = 0; j < attachmentParts.length; j++) {
            const part = attachmentParts[j];
            console.log(`[${requestId}] 处理附件 ${j + 1}/${attachmentParts.length}`);
            
            try {
              const partData = await connection.getPartData(message, part);
              const filename = part.disposition?.filename || `attachment_${j}`;
              const fileType = detectFileType(filename, part.type);
              
              console.log(`[${requestId}]   文件名: "${filename}", 类型: ${fileType}`);
              
              if (fileType === 'pdf' || fileType === 'html') {
                const base64Data = Buffer.from(partData).toString('base64');
                attachments.push({ 
                  filename, 
                  fileType, 
                  base64Data, 
                  size: base64Data.length 
                });
                mailDebug.attachment.extracted++;
                mailDebug.attachment.types.push(fileType);
                console.log(`[${requestId}]   ✅ 提取成功 (${base64Data.length} 字符)`);
              } else {
                console.log(`[${requestId}]   ⏭️  跳过（非PDF/HTML）`);
              }
            } catch (error) { 
              console.warn(`[${requestId}]   ❌ 提取失败:`, error);
            }
          }
        } else {
          console.log(`[${requestId}] 邮件无struct结构`);
        }
        
        console.log(`[${requestId}] 附件提取完成，共 ${attachments.length} 个有效附件`);
        
        // HTML兜底提取（Uber收据场景）
        if (attachments.length === 0) {
          console.log(`[${requestId}] 无附件，尝试HTML兜底提取...`);
          mailDebug.htmlFallback = { attempted: true, success: false };
          
          if (parsedMail) {
            console.log(`[${requestId}]   parsedMail存在，检查HTML...`);
            const htmlStart = Date.now();
            const htmlReceipt = extractHtmlAsReceipt(parsedMail);
            
            if (htmlReceipt) {
              attachments.push(htmlReceipt);
              mailDebug.htmlFallback.success = true;
              mailDebug.htmlFallback.size = htmlReceipt.size;
              console.log(`[${requestId}]   ✅ HTML兜底成功 (${htmlReceipt.size} 字符, ${Date.now() - htmlStart}ms)`);
            } else {
              console.log(`[${requestId}]   ❌ HTML兜底失败（无HTML或内容太短）`);
            }
          } else {
            console.log(`[${requestId}]   ❌ parsedMail不存在，无法提取HTML`);
          }
        }
        
        // 决定是否返回此邮件
        console.log(`[${requestId}] 最终附件数: ${attachments.length}`);
        mailDebug.finalAttachments = attachments.length;
        
        if (attachments.length > 0) {
          console.log(`[${requestId}] ✅ 邮件符合条件，加入返回列表`);
          
          emailResults.push({ 
            uid, 
            subject, 
            from, 
            date, 
            platform_name: matchResult.platformName, 
            attachments 
          });
          processedCount++;
          
          mailDebug.addedToResults = true;
          console.log(`[${requestId}]   已处理 ${processedCount}/${maxFetchCount} 封邮件`);
        } else {
          console.log(`[${requestId}] ❌ 邮件无有效内容，不返回`);
          mailDebug.addedToResults = false;
          mailDebug.skippedReason = 'no_attachments_or_html';
        }
        
        debugLog.push(mailDebug);
        
        // 标记为已读
        try { 
          await connection.addFlags(uid, '\\Seen'); 
          console.log(`[${requestId}] 已标记为已读 UID:${uid}`);
        } catch (e) {
          console.warn(`[${requestId}] 标记已读失败:`, e);
        }
        
      } catch (error) { 
        console.error(`[${requestId}] ❌ 处理邮件失败:`, error);
        mailDebug.processError = error.message;
        debugLog.push(mailDebug);
      }
    }
    
    clearTimeout(timeout);
    
    const totalTime = Date.now() - requestId;
    console.log('\n=====================================================');
    console.log(`[${requestId}] ========== 请求处理完成 ==========`);
    console.log(`[${requestId}] 找到邮件总数: ${messages.length}`);
    console.log(`[${requestId}] 返回邮件数: ${emailResults.length}`);
    console.log(`[${requestId}] 最后UID: ${maxUid}`);
    console.log(`[${requestId}] 总耗时: ${totalTime}ms`);
    console.log('=====================================================\n');
    
    // 【新增】返回调试信息
    res.status(200).json({ 
      success: true, 
      emails: emailResults, 
      lastUid: maxUid,
      debug: { 
        log: debugLog, 
        totalTime, 
        found: messages.length, 
        returned: emailResults.length 
      }
    });
    
  } catch (error: any) {
    clearTimeout(timeout);
    console.error(`[${requestId}] ❌ 请求处理失败:`, error);
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Unknown error',
      debug: { error: error.message, stack: error.stack }
    });
  } finally {
    if (connection) {
      try { 
        await connection.logout(); 
        console.log(`[${requestId}] IMAP连接已关闭`);
      } catch (e) {
        console.warn(`[${requestId}] 关闭连接失败:`, e);
      }
    }
  }
}

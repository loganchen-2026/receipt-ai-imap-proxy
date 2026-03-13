/**
 * @file api/fetch-emails.ts
 * @description Vercel 无状态 IMAP 代理 - 阅后即焚翻译官
 * 调试版：添加详细日志，定位邮件过滤问题
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { simpleParser } from 'mailparser';
import { connect } from 'imap-simple';

// ... 所有接口定义保持不变 ...

/**
 * 安全字符串转换
 */
function safeString(value: any): string {
  if (value === null || value === undefined || typeof value === 'string' && value.trim() === '') {
    return '';
  }
  return String(value).trim();
}

/**
 * 安全布尔转换
 */
function safeBool(value: any): boolean {
  if (value === true || value === 1 || value === 'true' || value === '1') {
    return true;
  }
  return false;
}

/**
 * 检测文件类型
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
 * 构建 IMAP 搜索条件
 */
function buildSearchCriteria(searchRules: ThreeDMatchRule[], lastProcessedUid?: number): any[] {
  const criteria: any[] = ['UNSEEN'];
  
  if (lastProcessedUid && lastProcessedUid > 0) {
    criteria.push(['UID', `${lastProcessedUid + 1}:*`]);
  }
  
  const defaultSinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 改为90天
  criteria.push(['SINCE', defaultSinceDate]);
  
  console.log('[IMAP Proxy] ===== 搜索条件构建 =====');
  console.log('[IMAP Proxy] 原始规则:', JSON.stringify(searchRules));
  
  const enabledRules = (searchRules || []).filter(rule => safeBool(rule.enabled));
  console.log('[IMAP Proxy] 启用规则数:', enabledRules.length);
  
  const validFromRules = enabledRules.filter(rule => {
    const from = safeString(rule.from);
    return from !== '';
  });
  
  const validSubjectRules = enabledRules.filter(rule => {
    const subject = safeString(rule.subject);
    return subject !== '';
  });
  
  console.log('[IMAP Proxy] 有效FROM规则:', validFromRules.length);
  console.log('[IMAP Proxy] 有效SUBJECT规则:', validSubjectRules.length);
  
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
  
  console.log('[IMAP Proxy] 最终搜索条件:', JSON.stringify(criteria));
  return criteria;
}

/**
 * 三维规则匹配（调试版）
 */
function matchesThreeDConditions(
  emailFrom: string, 
  emailSubject: string, 
  emailBody: string, 
  rules: ThreeDMatchRule[]
): { matched: boolean; platformName?: string; debugInfo?: string } {
  const enabledRules = (rules || []).filter(rule => safeBool(rule.enabled));
  
  console.log(`[IMAP Proxy] ===== 规则匹配检查 =====`);
  console.log(`[IMAP Proxy] 邮件FROM: "${emailFrom}"`);
  console.log(`[IMAP Proxy] 邮件SUBJECT: "${emailSubject}"`);
  console.log(`[IMAP Proxy] 邮件BODY长度: ${emailBody.length}`);
  console.log(`[IMAP Proxy] 启用规则数: ${enabledRules.length}`);
  
  if (enabledRules.length === 0) {
    console.log('[IMAP Proxy] 无启用规则，默认匹配');
    return { matched: true, platformName: '连通性测试', debugInfo: '无规则默认匹配' };
  }
  
  const matchedRule = enabledRules.find(rule => {
    const ruleFrom = safeString(rule.from);
    const ruleSubject = safeString(rule.subject);
    const ruleBody = safeString(rule.body_contains);
    
    const fromMatch = ruleFrom === '' || (emailFrom || '').toLowerCase().includes(ruleFrom.toLowerCase());
    const subjectMatch = ruleSubject === '' || (emailSubject || '').toLowerCase().includes(ruleSubject.toLowerCase());
    const bodyMatch = ruleBody === '' || (emailBody || '').toLowerCase().includes(ruleBody.toLowerCase());
    
    console.log(`[IMAP Proxy] 规则检查: FROM匹配=${fromMatch}, SUBJECT匹配=${subjectMatch}, BODY匹配=${bodyMatch}`);
    console.log(`[IMAP Proxy] 规则详情: from="${ruleFrom}", subject="${ruleSubject}", body="${ruleBody}"`);
    
    return fromMatch && subjectMatch && bodyMatch;
  });
  
  if (matchedRule) {
    console.log(`[IMAP Proxy] ✅ 匹配成功！平台: ${matchedRule.platform_name}`);
    return { 
      matched: true, 
      platformName: matchedRule.platform_name,
      debugInfo: `匹配规则: ${matchedRule.platform_name}`
    };
  }
  
  console.log('[IMAP Proxy] ❌ 未匹配任何规则');
  return { matched: false, debugInfo: '未匹配规则' };
}

/**
 * 提取HTML正文作为收据（调试版）
 */
function extractHtmlAsReceipt(parsedMail: any): AttachmentData | null {
  console.log('[IMAP Proxy] ===== HTML兜底提取检查 =====');
  
  if (!parsedMail) {
    console.log('[IMAP Proxy] ❌ parsedMail为空');
    return null;
  }
  
  console.log(`[IMAP Proxy] 是否有HTML: ${!!parsedMail.html}`);
  console.log(`[IMAP Proxy] HTML类型: ${typeof parsedMail.html}`);
  console.log(`[IMAP Proxy] HTML长度: ${parsedMail.html ? parsedMail.html.length : 0}`);
  
  if (parsedMail.html && typeof parsedMail.html === 'string' && parsedMail.html.length > 100) {
    const htmlContent = parsedMail.html;
    console.log(`[IMAP Proxy] ✅ HTML提取成功！长度: ${htmlContent.length}`);
    
    return {
      filename: 'email-receipt.html',
      fileType: 'html',
      base64Data: Buffer.from(htmlContent).toString('base64'),
      size: htmlContent.length
    };
  }
  
  console.log('[IMAP Proxy] ❌ HTML不符合要求（长度<=100或不存在）');
  return null;
}

/**
 * 提取纯文本邮件正文
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
 * Vercel API 主处理函数（调试版）
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      error: 'Method not allowed. Only POST requests are supported.' 
    });
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

  console.log('\n\n========== 新请求开始 ==========');
  console.log('[IMAP Proxy] 请求参数:', JSON.stringify({
    lastProcessedUid,
    maxFetchCount,
    ruleCount: searchRules.length
  }, null, 2));

  let connection: any = null;
  
  try {
    console.log('[IMAP Proxy] 正在连接IMAP服务器...');
    
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
    
    console.log('[IMAP Proxy] ✅ IMAP连接成功');
    
    await connection.openBox('INBOX');
    const searchCriteria = buildSearchCriteria(searchRules, lastProcessedUid);
    
    console.log('[IMAP Proxy] 正在搜索邮件...');
    const messages = await connection.search(searchCriteria, { 
      bodies: ['HEADER', 'TEXT'], 
      struct: true 
    });
    
    console.log(`[IMAP Proxy] ✅ 搜索完成！找到 ${messages.length} 封邮件`);
    
    const emailResults: EmailData[] = [];
    let maxUid = lastProcessedUid || 0;
    const sortedMessages = messages.sort((a: any, b: any) => b.attributes.uid - a.attributes.uid);
    
    console.log(`[IMAP Proxy] 按UID降序排序，准备处理 ${sortedMessages.length} 封邮件`);
    
    let processedCount = 0;
    for (let i = 0; i < sortedMessages.length; i++) {
      const message = sortedMessages[i];
      
      if (processedCount >= maxFetchCount) {
        console.log(`[IMAP Proxy] 已达到最大处理数 ${maxFetchCount}，停止处理`);
        break;
      }
      
      console.log(`\n[IMAP Proxy] ----- 处理第 ${i + 1}/${sortedMessages.length} 封邮件 -----`);
      
      try {
        const uid = message.attributes.uid;
        const headerPart = message.parts.find((part: any) => part.which === 'HEADER');
        const headerBody = headerPart?.body || {};
        
        const subject = headerBody.subject?.[0] || 'No Subject';
        const from = headerBody.from?.[0] || 'Unknown';
        const date = headerBody.date?.[0] || new Date().toISOString();
        
        console.log(`[IMAP Proxy] UID: ${uid}`);
        console.log(`[IMAP Proxy] 发件人: "${from}"`);
        console.log(`[IMAP Proxy] 主题: "${subject}"`);
        console.log(`[IMAP Proxy] 日期: ${date}`);
        
        if (uid > maxUid) {
          maxUid = uid;
          console.log(`[IMAP Proxy] 更新 maxUid: ${maxUid}`);
        }
        
        // 提取邮件正文
        let emailBody = '';
        let parsedMail: any = null;
        try {
          const messageData = await connection.getPartData(message);
          parsedMail = await simpleParser(messageData);
          emailBody = extractEmailBody(parsedMail);
          console.log(`[IMAP Proxy] 正文提取成功 (${emailBody.length} 字符)`);
        } catch (error) { 
          console.warn('[IMAP Proxy] 解析邮件正文失败:', error.message); 
        }
        
        // 规则匹配检查
        const matchResult = matchesThreeDConditions(from, subject, emailBody, searchRules);
        
        if (!matchResult.matched) {
          console.log(`[IMAP Proxy] ❌ 规则不匹配，跳过此邮件`);
          try { 
            await connection.addFlags(uid, '\\Seen'); 
            console.log(`[IMAP Proxy] 已标记为已读 UID:${uid}`);
          } catch (e) {
            console.warn('[IMAP Proxy] 标记已读失败:', e.message);
          }
          continue;
        }
        
        console.log(`[IMAP Proxy] ✅ 规则匹配成功！`);
        
        // 提取附件
        const attachments: AttachmentData[] = [];
        if (message.attributes.struct) {
          console.log('[IMAP Proxy] 开始提取附件...');
          const attachmentParts = findAttachmentParts(message.attributes.struct);
          
          for (let j = 0; j < attachmentParts.length; j++) {
            const part = attachmentParts[j];
            try {
              console.log(`[IMAP Proxy] 处理附件 ${j + 1}/${attachmentParts.length}`);
              const partData = await connection.getPartData(message, part);
              const filename = part.disposition?.filename || part.type || 'unknown';
              const fileType = detectFileType(filename, part.type);
              
              console.log(`[IMAP Proxy] 附件信息: filename="${filename}", fileType=${fileType}`);
              
              if (fileType === 'pdf' || fileType === 'html') {
                const base64Data = Buffer.from(partData).toString('base64');
                attachments.push({ 
                  filename, 
                  fileType, 
                  base64Data, 
                  size: base64Data.length 
                });
                console.log(`[IMAP Proxy] ✅ 附件提取成功: ${filename} (${fileType}, ${base64Data.length} 字符)`);
              } else {
                console.log(`[IMAP Proxy] ⏭️  跳过附件（非PDF/HTML）: ${filename} (${fileType})`);
              }
            } catch (error) { 
              console.warn('[IMAP Proxy] 提取附件失败:', error.message); 
            }
          }
        } else {
          console.log('[IMAP Proxy] 邮件无struct结构，跳过附件提取');
        }
        
        console.log(`[IMAP Proxy] 附件提取完成，共 ${attachments.length} 个附件`);
        
        // HTML兜底提取
        if (attachments.length === 0 && parsedMail) {
          console.log('[IMAP Proxy] 无附件，尝试HTML兜底提取...');
          const htmlReceipt = extractHtmlAsReceipt(parsedMail);
          if (htmlReceipt) {
            attachments.push(htmlReceipt);
            console.log(`[IMAP Proxy] ✅ HTML兜底成功！`);
          } else {
            console.log('[IMAP Proxy] ❌ HTML兜底失败（无HTML或内容太短）');
          }
        }
        
        // 决定是否返回此邮件
        if (attachments.length > 0) {
          console.log(`[IMAP Proxy] ✅ 邮件有资格返回！附件数: ${attachments.length}`);
          
          emailResults.push({ 
            uid, 
            subject, 
            from, 
            date, 
            platform_name: matchResult.platformName, 
            attachments 
          });
          
          processedCount++;
          console.log(`[IMAP Proxy] 已处理 ${processedCount}/${maxFetchCount} 封邮件`);
        } else {
          console.log('[IMAP Proxy] ❌ 邮件无附件且HTML兜底失败，不返回');
        }
        
        // 标记为已读
        try { 
          await connection.addFlags(uid, '\\Seen'); 
          console.log(`[IMAP Proxy] 已标记为已读 UID:${uid}`);
        } catch (e) {
          console.warn('[IMAP Proxy] 标记已读失败:', e.message);
        }
        
      } catch (error) { 
        console.error('[IMAP Proxy] 处理邮件失败:', error.message);
        console.error('[IMAP Proxy] 错误详情:', error);
      }
    }
    
    console.log('\n========== 请求处理完成 ==========');
    console.log(`[IMAP Proxy] 找到邮件总数: ${messages.length}`);
    console.log(`[IMAP Proxy] 返回邮件数: ${emailResults.length}`);
    console.log(`[IMAP Proxy] 最后UID: ${maxUid}`);
    
    res.status(200).json({ 
      success: true, 
      emails: emailResults, 
      lastUid: maxUid 
    });
    
  } catch (error: any) {
    console.error('\n========== 请求处理失败 ==========');
    console.error('[IMAP Proxy] 错误:', error.message);
    console.error('[IMAP Proxy] 错误堆栈:', error.stack);
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Unknown error occurred' 
    });
  } finally {
    if (connection) {
      try { 
        await connection.logout(); 
        console.log('[IMAP Proxy] IMAP连接已关闭');
      } catch (e) {
        console.warn('[IMAP Proxy] 关闭连接失败:', e.message);
      }
    }
  }
}

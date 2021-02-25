import { Session, segment, MessageInfo, AuthorInfo, GroupInfo, UserInfo } from 'koishi-core'
import { DiscordBot } from './bot'
import * as DC from './types'
export const adaptUser = (user: DC.User): UserInfo => ({
  userId: user.id,
  avatar: user.avatar,
  username: user.username,
})

export const adaptAuthor = (author: DC.Author): AuthorInfo => ({
  ...adaptUser(author),
  nickname: author.username,
})

function adaptMessage(bot: DiscordBot, base: any, meta: DC.MessageCreateBody, session: MessageInfo = {}) {
  if (meta.author) {
    session.author = adaptAuthor(meta.author)
    session.userId = meta.author.id
  }
  if (meta.embeds.length === 0) {
    // pure message
    session.content = meta.content
    if (meta.attachments.length) {
      session.content += meta.attachments.map(v => segment('image', {
        url: v.url,
        file: v.filename,
      })).join('')
    }
    session.content = session.content.replace(/<@!(.+?)>/, (_, v) => segment('at', {
      id: v,
    }))
  } else {
    switch (meta.embeds[0].type) {
      case 'video':
        session.content = segment('video', { file: meta.embeds[0].url })
        break
      case 'image':
        session.content = segment('image', { file: meta.embeds[0].url })
        break
      case 'gifv':
        session.content = segment('video', { file: meta.embeds[0].video.url })
        break
      case 'link':
        session.content = segment('image', { url: meta.embeds[0].url, title: meta.embeds[0].title, content: meta.embeds[0].description })
        break
    }
  }
  return session
}

async function adaptMessageSession(bot: DiscordBot, data: DC.Payload, meta: DC.MessageCreateBody, session: Partial<Session.Payload<Session.MessageAction>> = {}) {
  adaptMessage(bot, data, meta, session)
  session.messageId = meta.id
  session.timestamp = new Date(meta.timestamp).valueOf()
  session.subtype = meta.guild_id ? 'group' : 'private'
  if (meta.message_reference) {
    const msg = await bot.getMessage(meta.message_reference.channel_id, meta.message_reference.message_id)
    session.quote = await adaptMessage(bot, null, msg)
    session.quote.messageId = meta.message_reference.message_id
    session.quote.channelId = meta.message_reference.channel_id
  }
  return session
}

async function adaptMessageCreate(bot: DiscordBot, data: DC.Payload, meta: DC.MessageCreateBody, session: Partial<Session.Payload<Session.MessageAction>>) {
  await adaptMessageSession(bot, data, meta, session)
  session.groupId = meta.guild_id
  session.subtype = meta.guild_id ? 'group' : 'private'
  session.channelId = meta.channel_id
}

async function adaptMessageModify(bot: DiscordBot, data: DC.Payload, meta: DC.MessageCreateBody, session: Partial<Session.Payload<Session.MessageAction>>) {
  await adaptMessageSession(bot, data, meta, session)
  session.groupId = meta.guild_id
  session.subtype = meta.guild_id ? 'group' : 'private'
  session.channelId = meta.channel_id
}

export async function adaptSession(bot: DiscordBot, input: DC.Payload) {
  const session: Partial<Session.Payload<Session.MessageAction>> = {
    selfId: bot.selfId,
    platform: 'discord',
  }
  if (input.t === 'MESSAGE_CREATE') {
    session.type = 'message'
    await adaptMessageCreate(bot, input, input.d as DC.MessageCreateBody, session)
    if (!session.content) return
    if (session.userId === bot.selfId) return
  } else if (input.t === 'MESSAGE_UPDATE') {
    session.type = 'message-updated'
    await adaptMessageModify(bot, input, input.d as DC.MessageCreateBody, session)
    if (!session.content) return
    if (session.userId === bot.selfId) return
  } else if (input.t === 'MESSAGE_DELETE') {
    session.type = 'message-deleted'
    session.messageId = input.d.id
  }
  return new Session(bot.app, session)
}

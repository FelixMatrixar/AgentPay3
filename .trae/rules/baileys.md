Directory structure:
└── whiskeysockets-baileys/
    ├── Example/
    │   └── example.ts
    ├── proto-extract/
    │   └── index.js
    └── src/
        ├── index.ts
        ├── Defaults/
        │   ├── baileys-version.json
        │   └── index.ts
        ├── Signal/
        │   ├── libsignal.ts
        │   ├── lid-mapping.ts
        │   └── Group/
        │       ├── ciphertext-message.ts
        │       ├── group-session-builder.ts
        │       ├── group_cipher.ts
        │       ├── index.ts
        │       ├── keyhelper.ts
        │       ├── sender-chain-key.ts
        │       ├── sender-key-distribution-message.ts
        │       ├── sender-key-message.ts
        │       ├── sender-key-name.ts
        │       ├── sender-key-record.ts
        │       ├── sender-key-state.ts
        │       └── sender-message-key.ts
        ├── Socket/
        │   ├── business.ts
        │   ├── chats.ts
        │   ├── communities.ts
        │   ├── groups.ts
        │   ├── index.ts
        │   ├── messages-recv.ts
        │   ├── messages-send.ts
        │   ├── mex.ts
        │   ├── newsletter.ts
        │   ├── socket.ts
        │   └── Client/
        │       ├── index.ts
        │       ├── types.ts
        │       └── websocket.ts
        ├── Types/
        │   ├── Auth.ts
        │   ├── Bussines.ts
        │   ├── Call.ts
        │   ├── Chat.ts
        │   ├── Contact.ts
        │   ├── Events.ts
        │   ├── globals.d.ts
        │   ├── GroupMetadata.ts
        │   ├── index.ts
        │   ├── Label.ts
        │   ├── LabelAssociation.ts
        │   ├── Message.ts
        │   ├── Newsletter.ts
        │   ├── Product.ts
        │   ├── Signal.ts
        │   ├── Socket.ts
        │   ├── State.ts
        │   └── USync.ts
        └── Utils/
            ├── auth-utils.ts
            ├── baileys-event-stream.ts
            ├── browser-utils.ts
            ├── business.ts
            ├── chat-utils.ts
            ├── crypto.ts
            ├── decode-wa-message.ts
            ├── event-buffer.ts
            ├── generics.ts
            ├── history.ts
            ├── index.ts
            ├── link-preview.ts
            ├── logger.ts
            ├── lt-hash.ts
            ├── make-mutex.ts
            ├── message-retry-manager.ts
            ├── messages-media.ts
            ├── messages.ts
            ├── noise-handler.ts
            ├── pre-key-manager.ts
            ├── process-message.ts
            ├── signal.ts
            ├── use-multi-file-auth-state.ts
            └── validate-connection.ts

================================================
FILE: Example/example.ts
================================================
import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, BinaryInfo, CacheStore, delay, DisconnectReason, downloadAndProcessHistorySyncNotification, encodeWAM, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, getHistoryMsg, isJidNewsletter, jidDecode, makeCacheableSignalKeyStore, normalizeMessageContent, PatchedMessageWithRecipientJID, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
//import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import P from 'pino'
import { WAMHandler } from './wam'

const logger = P({
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "trace",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})
logger.level = 'trace'

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage
	})


	const wam = new WAMHandler(sock, state)

	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		// todo move to QR event
		const phoneNumber = await question('Please enter your phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}
				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events['labels.association']) {
				console.log(events['labels.association'])
			}


			if(events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if(events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					console.log('received on-demand history sync, messages=', messages)
				}
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

        if (!!upsert.requestId) {
          console.log("placeholder message received for request of id=" + upsert.requestId, upsert)
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
                console.log('requested placeholder resync, id=', messageId)
              }

              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                console.log('requested on-demand sync, id=', messageId)
              }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {

                console.log('replying to', msg.key.remoteJid)
                await sock!.readMessages([msg.key])
                await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
              }
            }
          }
        }
      }

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				console.log(
					JSON.stringify(events['messages.update'], undefined, 2)
				)

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation: proto.IMessage = {} // get the poll creation message somehow
						if(pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if(events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if(events['presence.update']) {
				console.log(events['presence.update'])
			}

			if(events['chats.update']) {
				console.log(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if(events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
	  // Implement a way to retreive messages that were upserted from messages.upsert
			// up to you

		// only if store is present
		return proto.Message.create({ conversation: 'test' })
	}
}

startSock()



================================================
FILE: proto-extract/index.js
================================================
const request = require('request-promise-native');
const acorn = require('acorn');
const walk = require('acorn-walk');
const fs = require('fs/promises');

let whatsAppVersion = 'latest';

const addPrefix = (lines, prefix) => lines.map((line) => prefix + line);

const extractAllExpressions = (node) => {
  const expressions = [node];
  const exp = node.expression;
  if (exp) {
    expressions.push(exp);
  }
  if(node?.expression?.arguments?.length) {
    for (const arg of node?.expression?.arguments) {
      if(arg?.body?.body?.length){
        for(const exp of arg?.body.body) {
          expressions.push(...extractAllExpressions(exp));
        }
      }
    }
  }
  if(node?.body?.body?.length) {
    for (const exp of node?.body?.body) {
      if(exp.expression){
        expressions.push(...extractAllExpressions(exp.expression));
      }
    }
  }
  
  if (node.expression?.expressions?.length) {
    for (const exp of node.expression?.expressions) {
      expressions.push(...extractAllExpressions(exp));
    }
  }

  return expressions;
};


async function findAppModules() {
  const ua = {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0',
      'Sec-Fetch-Dest': 'script',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
      Referer: 'https://web.whatsapp.com/',
      Accept: '*/*',
      'Accept-Language': 'Accept-Language: en-US,en;q=0.5',
    },
  };
  const baseURL = 'https://web.whatsapp.com';
  const serviceworker = await request.get(`${baseURL}/sw.js`, ua);

  const versions = [
    ...serviceworker.matchAll(/client_revision\\":([\d\.]+),/g),
  ].map((r) => r[1]);
  const version = versions[0];
  console.log(`Current version: 2.3000.${version}`);

  const waVersion = `2.3000.${version}`;
  whatsAppVersion = waVersion;

  let bootstrapQRURL = '';
  const clearString = serviceworker.replaceAll('/*BTDS*/', '');
  const URLScript = clearString.match(/(?<=importScripts\(["'])(.*?)(?=["']\);)/g);
  bootstrapQRURL = new URL(URLScript[0].replaceAll("\\",'')).href;

  console.info('Found source JS URL:', bootstrapQRURL);

  const qrData = await request.get(bootstrapQRURL, ua);

  // This one list of types is so long that it's split into two JavaScript declarations.
  // The module finder below can't handle it, so just patch it manually here.
  const patchedQrData = qrData.replaceAll(
    'LimitSharing$Trigger',
    'LimitSharing$TriggerType'
  );

  const qrModules = acorn.parse(patchedQrData).body;
  
  const result = qrModules.filter((m) => {
    const expressions = extractAllExpressions(m);
    return expressions?.find(
      (e) => { 
        return e?.left?.property?.name === 'internalSpec'
      }
    );
  });
  return result;
}

(async () => {
  const unspecName = (name) =>
    name.endsWith('Spec') ? name.slice(0, -4) : name;
  const unnestName = (name) => name.split('$').slice(-1)[0];
  const getNesting = (name) => name.split('$').slice(0, -1).join('$');
  const makeRenameFunc = () => (name) => {
    name = unspecName(name);
    return name; // .replaceAll('$', '__')
    //  return renames[name] ?? unnestName(name)
  };
  // The constructor IDs that can be used for enum types

  const modules = await findAppModules();

  // find aliases of cross references between the wanted modules
  const modulesInfo = {};
  const moduleIndentationMap = {};
  modules.forEach((module) => {
    const moduleName = module.expression.arguments[0].value;
    modulesInfo[moduleName] = { crossRefs: [] };
    walk.simple(module, {
      AssignmentExpression(node) {
        if (
          node &&
          node?.right?.type == 'CallExpression' &&
          node?.right?.arguments?.length == 1 &&
          node?.right?.arguments[0].type !== 'ObjectExpression'
        ) {
          /*if(node.right.arguments[0].value == '$InternalEnum') {
            console.log(node);
            console.log(node.right.arguments[0]);
            exit;
          }*/
          modulesInfo[moduleName].crossRefs.push({
            alias: node.left.name,
            module: node.right.arguments[0].value,
          });
        }
      },
    });
  });

  // find all identifiers and, for enums, their array of values
  for (const mod of modules) {
    const modInfo = modulesInfo[mod.expression.arguments[0].value];
    const rename = makeRenameFunc(mod.expression.arguments[0].value);

    const assignments = []
    walk.simple(mod, {
      AssignmentExpression(node) {
        const left = node.left;
        if(
            left.property?.name && 
            left.property?.name !== 'internalSpec' && 
            left.property?.name !== 'internalDefaults' &&
            left.property?.name !== 'name'
        ) {
          assignments.push(left);
        }
      },
    });


    const makeBlankIdent = (a) => {
      const key = rename(a?.property?.name);
      const indentation = getNesting(key);
      const value = { name: key };

      moduleIndentationMap[key] = moduleIndentationMap[key] || {};
      moduleIndentationMap[key].indentation = indentation;

      if (indentation.length) {
        moduleIndentationMap[indentation] =
          moduleIndentationMap[indentation] || {};
        moduleIndentationMap[indentation].members =
          moduleIndentationMap[indentation].members || new Set();
        moduleIndentationMap[indentation].members.add(key);
      }

      return [key, value];
    };

    modInfo.identifiers = Object.fromEntries(
      assignments.map(makeBlankIdent).reverse()
    );
    const enumAliases = {};
    // enums are defined directly, and both enums and messages get a one-letter alias
    walk.ancestor(mod, {
      Property(node, anc) {
        const fatherNode = anc[anc.length - 3];
        const fatherFather = anc[anc.length - 4];
        if(
          fatherNode?.type === 'AssignmentExpression' && 
          fatherNode?.left?.property?.name == 'internalSpec' 
          && fatherNode?.right?.properties.length
        ) {
          const values = fatherNode?.right?.properties.map((p) => ({
            name: p.key.name,
            id: p.value.value,
          }));
          const nameAlias = fatherNode?.left?.name;
          enumAliases[nameAlias] = values;
        }
        else if (node?.key && node?.key?.name && fatherNode.arguments?.length > 0) {
          const values = fatherNode.arguments?.[0]?.properties.map((p) => ({
            name: p.key.name,
            id: p.value.value,
          }));
          const nameAlias = fatherFather?.left?.name || fatherFather.id.name;
          enumAliases[nameAlias] = values;
        }
      },
    });
    walk.simple(mod, {
      AssignmentExpression(node) {
        if (
          node.left.type === 'MemberExpression' &&
          modInfo.identifiers?.[rename(node.left.property.name)]
        ) {
          const ident = modInfo.identifiers[rename(node.left.property.name)];
          ident.alias = node.right.name;
          ident.enumValues = enumAliases[ident.alias];
        }
      },
    });
  }

  // find the contents for all protobuf messages
  for (const mod of modules) {
    const modInfo = modulesInfo[mod.expression.arguments[0].value];
    const rename = makeRenameFunc(mod.expression.arguments[0].value);
    const findByAliasInIdentifier = (obj, alias) => {
      return Object.values(obj).find(item => item.alias === alias);
    };

    // message specifications are stored in a "internalSpec" attribute of the respective identifier alias
    walk.simple(mod, {
      AssignmentExpression(node) {
        if (
          node.left.type === 'MemberExpression' &&
          node.left.property.name === 'internalSpec' &&
          node.right.type === 'ObjectExpression'
        ) {
          const targetIdent = Object.values(modInfo.identifiers).find(
            (v) => v.alias === node.left.object.name
          );
          if (!targetIdent) {
            console.warn(
              `found message specification for unknown identifier alias: ${node.left.object.name}`
            );
            return;
          }

          // partition spec properties by normal members and constraints (like "__oneofs__") which will be processed afterwards
          const constraints = [];
          let members = [];
          for (const p of node.right.properties) {
            p.key.name = p.key.type === 'Identifier' ? p.key.name : p.key.value;
            const arr =
              p.key.name.substr(0, 2) === '__' ? constraints : members;
            arr.push(p);
          }

          members = members.map(({ key: { name }, value: { elements } }) => {
            let type;
            const flags = [];
            const unwrapBinaryOr = (n) =>
              n.type === 'BinaryExpression' && n.operator === '|'
                ? [].concat(unwrapBinaryOr(n.left), unwrapBinaryOr(n.right))
                : [n];

            // find type and flags
            unwrapBinaryOr(elements[1]).forEach((m) => {
              if (
                m.type === 'MemberExpression' &&
                m.object.type === 'MemberExpression'
              ) {
                if (m.object.property.name === 'TYPES') {
                  type = m.property.name.toLowerCase();
                  if(type == 'map'){

                    let typeStr = 'map<';
                    if (elements[2]?.type === 'ArrayExpression') {
                      const subElements = elements[2].elements;
                      subElements.forEach((element, index) => {
                        if(element?.property?.name) {
                          typeStr += element?.property?.name?.toLowerCase();
                        } else {
                          const ref = findByAliasInIdentifier(modInfo.identifiers, element.name);
                          typeStr += ref.name;
                        }
                        if (index < subElements.length - 1) {
                            typeStr += ', ';
                        }
                      });
                      typeStr += '>';
                      type = typeStr;
                    }
                  }
                } else if (m.object.property.name === 'FLAGS') {
                  flags.push(m.property.name.toLowerCase());
                }
              }
            });

            // determine cross reference name from alias if this member has type "message" or "enum"
            
            if (type === 'message' || type === 'enum') {
              const currLoc = ` from member '${name}' of message ${targetIdent.name}'`;
              if (elements[2].type === 'Identifier') {
                type = Object.values(modInfo.identifiers).find(
                  (v) => v.alias === elements[2].name
                )?.name;
                if (!type) {
                  console.warn(
                    `unable to find reference of alias '${elements[2].name}'` +
                      currLoc
                  );
                }
              } else if (elements[2].type === 'MemberExpression') {
                let crossRef = modInfo.crossRefs.find(
                  (r) => r.alias === elements[2]?.object?.name || elements[2]?.object?.left?.name || elements[2]?.object?.callee?.name
                );
                if(elements[1]?.property?.name === 'ENUM' && elements[2]?.property?.name?.includes('Type')) {
                  type = rename(elements[2]?.property?.name);
                }
                else if(elements[2]?.property?.name.includes('Spec')) {
                  type = rename(elements[2].property.name);
                } else if (
                  crossRef &&
                  crossRef.module !== '$InternalEnum' &&
                  modulesInfo[crossRef.module].identifiers[
                    rename(elements[2].property.name)
                  ]
                ) {
                  type = rename(elements[2].property.name);
                } else {
                  console.warn(
                    `unable to find reference of alias to other module '${elements[2].object.name}' or to message ${elements[2].property.name} of this module` +
                      currLoc
                  );
                }
              }
            }

            return { name, id: elements[0].value, type, flags };
          });

          // resolve constraints for members
          constraints.forEach((c) => {
            if (
              c.key.name === '__oneofs__' &&
              c.value.type === 'ObjectExpression'
            ) {
              const newOneOfs = c.value.properties.map((p) => ({
                name: p.key.name,
                type: '__oneof__',
                members: p.value.elements.map((e) => {
                  const idx = members.findIndex((m) => m.name === e.value);
                  const member = members[idx];
                  members.splice(idx, 1);
                  return member;
                }),
              }));
              members.push(...newOneOfs);
            }
          });

          targetIdent.members = members;
        }
      },
    });
  }

  const decodedProtoMap = {};
  const spaceIndent = ' '.repeat(4);
  for (const mod of modules) {
    const modInfo = modulesInfo[mod.expression.arguments[0].value];
    const identifiers = Object.values(modInfo?.identifiers);
  
    // enum stringifying function
    const stringifyEnum = (ident, overrideName = null) =>
      [].concat(
        [`enum ${overrideName || ident.displayName || ident.name} {`],
        addPrefix(
          ident.enumValues.map((v) => `${v.name} = ${v.id};`),
          spaceIndent
        ),
        ['}']
      );

    // message specification member stringifying function
    const stringifyMessageSpecMember = (
      info,
      completeFlags,
      parentName = undefined
    ) => {
      if (info.type === '__oneof__') {
        return [].concat(
          [`oneof ${info.name} {`],
          addPrefix(
            [].concat(
              ...info.members.map((m) => stringifyMessageSpecMember(m, false))
            ),
            spaceIndent
          ),
          ['}']
        );
      } else {
        if (info.flags.includes('packed')) {
          info.flags.splice(info.flags.indexOf('packed'));
          info.packed = ' [packed=true]';
        }
        if (completeFlags && info.flags.length === 0 && !info.type.includes('map')) {
          info.flags.push('optional');
        }

        const ret = [];
        const indentation = moduleIndentationMap[info.type]?.indentation;
        let typeName = unnestName(info.type);
        if (indentation !== parentName && indentation) {
          typeName = `${indentation.replaceAll('$', '.')}.${typeName}`;
        }

        // if(info.enumValues) {
        //     // typeName = unnestName(info.type)
        //     ret = stringifyEnum(info, typeName)
        // }

        ret.push(
          `${
            info.flags.join(' ') + (info.flags.length === 0 ? '' : ' ')
          }${typeName} ${info.name} = ${info.id}${info.packed || ''};`
        );
        return ret;
      }
    };

    // message specification stringifying function
    const stringifyMessageSpec = (ident) => {
      const members = moduleIndentationMap[ident.name]?.members;
      const result = [];
      result.push(
        `message ${ident.displayName || ident.name} {`,
        ...addPrefix(
          [].concat(
            ...ident.members.map((m) =>
              stringifyMessageSpecMember(m, true, ident.name)
            )
          ),
          spaceIndent
        )
      );

      if (members?.size) {
        const sortedMembers = Array.from(members).sort();
        for (const memberName of sortedMembers) {
          let entity = modInfo.identifiers[memberName];
          if (entity) {
            const displayName = entity.name.slice(ident.name.length + 1);
            entity = { ...entity, displayName };
            result.push(...addPrefix(getEntity(entity), spaceIndent));
          } else {
            console.log('missing nested entity ', memberName);
          }
        }
      }

      result.push('}');
      result.push('');

      return result;
    };

    const getEntity = (v) => {
      let result;
      if (v.members) {
        result = stringifyMessageSpec(v);
      } else if (v.enumValues?.length) {
        result = stringifyEnum(v);
      } else {
        result = ['// Unknown entity ' + v.name];
      }

      return result;
    };

    const stringifyEntity = (v) => {
      return {
        content: getEntity(v).join('\n'),
        name: v.name,
      };
    };

    for (const value of identifiers) {
      const { name, content } = stringifyEntity(value);
      if (!moduleIndentationMap[name]?.indentation?.length) {
        decodedProtoMap[name] = content;
      }
    }
  }

  const decodedProto = Object.keys(decodedProtoMap).sort();
  const sortedStr = decodedProto.map((d) => decodedProtoMap[d]).join('\n');

  const decodedProtoStr = `syntax = "proto3";\npackage proto;\n\n/// WhatsApp Version: ${whatsAppVersion}\n\n${sortedStr}`;
  const destinationPath = '../WAProto/WAProto.proto';
  await fs.writeFile(destinationPath, decodedProtoStr);

  console.log(`Extracted protobuf schema to "${destinationPath}"`);
})();


================================================
FILE: src/index.ts
================================================
import makeWASocket from './Socket/index'

export * from '../WAProto/index.js'
export * from './Utils/index'
export * from './Types/index'
export * from './Defaults/index'
export * from './WABinary/index'
export * from './WAM/index'
export * from './WAUSync/index'

export type WASocket = ReturnType<typeof makeWASocket>
export { makeWASocket }
export default makeWASocket



================================================
FILE: src/Defaults/baileys-version.json
================================================
{
	"version": [2, 3000, 1027934701]
}



================================================
FILE: src/Defaults/index.ts
================================================
import { proto } from '../../WAProto/index.js'
import { makeLibSignalRepository } from '../Signal/libsignal'
import type { AuthenticationState, SocketConfig, WAVersion } from '../Types'
import { Browsers } from '../Utils/browser-utils'
import logger from '../Utils/logger'

const version = [2, 3000, 1027934701]

export const UNAUTHORIZED_CODES = [401, 403, 419]

export const DEFAULT_ORIGIN = 'https://web.whatsapp.com'
export const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/'
export const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/'
export const DEF_CALLBACK_PREFIX = 'CB:'
export const DEF_TAG_PREFIX = 'TAG:'
export const PHONE_CONNECTION_CB = 'CB:Pong'

export const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
export const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6])

export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60

export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'
export const DICT_VERSION = 3
export const KEY_BUNDLE_TYPE = Buffer.from([5])
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]) // last is "DICT_VERSION"
/** from: https://stackoverflow.com/questions/3809401/what-is-a-good-regular-expression-to-match-a-url */
export const URL_REGEX = /https:\/\/(?![^:@\/\s]+:[^:@\/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g

export const WA_CERT_DETAILS = {
	SERIAL: 0
}

export const PROCESSABLE_HISTORY_TYPES = [
	proto.Message.HistorySyncNotification.HistorySyncType.INITIAL_BOOTSTRAP,
	proto.Message.HistorySyncNotification.HistorySyncType.PUSH_NAME,
	proto.Message.HistorySyncNotification.HistorySyncType.RECENT,
	proto.Message.HistorySyncNotification.HistorySyncType.FULL,
	proto.Message.HistorySyncNotification.HistorySyncType.ON_DEMAND,
	proto.Message.HistorySyncNotification.HistorySyncType.NON_BLOCKING_DATA,
	proto.Message.HistorySyncNotification.HistorySyncType.INITIAL_STATUS_V3
]

export const DEFAULT_CONNECTION_CONFIG: SocketConfig = {
	version: version as WAVersion,
	browser: Browsers.macOS('Chrome'),
	waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
	connectTimeoutMs: 20_000,
	keepAliveIntervalMs: 30_000,
	logger: logger.child({ class: 'baileys' }),
	emitOwnEvents: true,
	defaultQueryTimeoutMs: 60_000,
	customUploadHosts: [],
	retryRequestDelayMs: 250,
	maxMsgRetryCount: 5,
	fireInitQueries: true,
	auth: undefined as unknown as AuthenticationState,
	markOnlineOnConnect: true,
	syncFullHistory: true,
	patchMessageBeforeSending: msg => msg,
	shouldSyncHistoryMessage: () => true,
	shouldIgnoreJid: () => false,
	linkPreviewImageThumbnailWidth: 192,
	transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
	generateHighQualityLinkPreview: false,
	enableAutoSessionRecreation: true,
	enableRecentMessageCache: true,
	options: {},
	appStateMacVerification: {
		patch: false,
		snapshot: false
	},
	countryCode: 'US',
	getMessage: async () => undefined,
	cachedGroupMetadata: async () => undefined,
	makeSignalRepository: makeLibSignalRepository
}

export const MEDIA_PATH_MAP: { [T in MediaType]?: string } = {
	image: '/mms/image',
	video: '/mms/video',
	document: '/mms/document',
	audio: '/mms/audio',
	sticker: '/mms/image',
	'thumbnail-link': '/mms/image',
	'product-catalog-image': '/product/image',
	'md-app-state': '',
	'md-msg-hist': '/mms/md-app-state',
	'biz-cover-photo': '/pps/biz-cover-photo'
}

export const MEDIA_HKDF_KEY_MAPPING = {
	audio: 'Audio',
	document: 'Document',
	gif: 'Video',
	image: 'Image',
	ppic: '',
	product: 'Image',
	ptt: 'Audio',
	sticker: 'Image',
	video: 'Video',
	'thumbnail-document': 'Document Thumbnail',
	'thumbnail-image': 'Image Thumbnail',
	'thumbnail-video': 'Video Thumbnail',
	'thumbnail-link': 'Link Thumbnail',
	'md-msg-hist': 'History',
	'md-app-state': 'App State',
	'product-catalog-image': '',
	'payment-bg-image': 'Payment Background',
	ptv: 'Video',
	'biz-cover-photo': 'Image'
}

export type MediaType = keyof typeof MEDIA_HKDF_KEY_MAPPING

export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP) as MediaType[]

export const MIN_PREKEY_COUNT = 5

export const INITIAL_PREKEY_COUNT = 812

export const UPLOAD_TIMEOUT = 30000 // 30 seconds
export const MIN_UPLOAD_INTERVAL = 5000 // 5 seconds minimum between uploads

export const DEFAULT_CACHE_TTLS = {
	SIGNAL_STORE: 5 * 60, // 5 minutes
	MSG_RETRY: 60 * 60, // 1 hour
	CALL_OFFER: 5 * 60, // 5 minutes
	USER_DEVICES: 5 * 60 // 5 minutes
}



================================================
FILE: src/Signal/libsignal.ts
================================================
/* @ts-ignore */
import * as libsignal from 'libsignal'
import { LRUCache } from 'lru-cache'
import type { LIDMapping, SignalAuthState, SignalKeyStoreWithTransaction } from '../Types'
import type { SignalRepositoryWithLIDStore } from '../Types/Signal'
import { generateSignalPubKey } from '../Utils'
import type { ILogger } from '../Utils/logger'
import { jidDecode, transferDevice, WAJIDDomains } from '../WABinary'
import type { SenderKeyStore } from './Group/group_cipher'
import { SenderKeyName } from './Group/sender-key-name'
import { SenderKeyRecord } from './Group/sender-key-record'
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group'
import { LIDMappingStore } from './lid-mapping'

export function makeLibSignalRepository(
	auth: SignalAuthState,
	logger: ILogger,
	pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>
): SignalRepositoryWithLIDStore {
	const lidMapping = new LIDMappingStore(auth.keys as SignalKeyStoreWithTransaction, logger, pnToLIDFunc)
	const storage = signalStorage(auth, lidMapping)

	const parsedKeys = auth.keys as SignalKeyStoreWithTransaction
	const migratedSessionCache = new LRUCache<string, true>({
		ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
		ttlAutopurge: true,
		updateAgeOnGet: true
	})

	const repository: SignalRepositoryWithLIDStore = {
		decryptGroupMessage({ group, authorJid, msg }) {
			const senderName = jidToSignalSenderKeyName(group, authorJid)
			const cipher = new GroupCipher(storage, senderName)

			// Use transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				return cipher.decrypt(msg)
			}, group)
		},
		async processSenderKeyDistributionMessage({ item, authorJid }) {
			const builder = new GroupSessionBuilder(storage)
			if (!item.groupId) {
				throw new Error('Group ID is required for sender key distribution message')
			}

			const senderName = jidToSignalSenderKeyName(item.groupId, authorJid)

			const senderMsg = new SenderKeyDistributionMessage(
				null,
				null,
				null,
				null,
				item.axolotlSenderKeyDistributionMessage
			)
			const senderNameStr = senderName.toString()
			const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
			if (!senderKey) {
				await storage.storeSenderKey(senderName, new SenderKeyRecord())
			}

			return parsedKeys.transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				await builder.process(senderName, senderMsg)
			}, item.groupId)
		},
		async decryptMessage({ jid, type, ciphertext }) {
			const addr = jidToSignalProtocolAddress(jid)
			const session = new libsignal.SessionCipher(storage, addr)

			async function doDecrypt() {
				let result: Buffer
				switch (type) {
					case 'pkmsg':
						result = await session.decryptPreKeyWhisperMessage(ciphertext)
						break
					case 'msg':
						result = await session.decryptWhisperMessage(ciphertext)
						break
				}

				return result
			}

			// If it's not a sync message, we need to ensure atomicity
			// For regular messages, we use a transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				return await doDecrypt()
			}, jid)
		},

		async encryptMessage({ jid, data }) {
			const addr = jidToSignalProtocolAddress(jid)
			const cipher = new libsignal.SessionCipher(storage, addr)

			// Use transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				const { type: sigType, body } = await cipher.encrypt(data)
				const type = sigType === 3 ? 'pkmsg' : 'msg'
				return { type, ciphertext: Buffer.from(body, 'binary') }
			}, jid)
		},

		async encryptGroupMessage({ group, meId, data }) {
			const senderName = jidToSignalSenderKeyName(group, meId)
			const builder = new GroupSessionBuilder(storage)

			const senderNameStr = senderName.toString()

			return parsedKeys.transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				const senderKeyDistributionMessage = await builder.create(senderName)
				const session = new GroupCipher(storage, senderName)
				const ciphertext = await session.encrypt(data)

				return {
					ciphertext,
					senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
				}
			}, group)
		},

		async injectE2ESession({ jid, session }) {
			logger.trace({ jid }, 'injecting E2EE session')
			const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid))
			return parsedKeys.transaction(async () => {
				await cipher.initOutgoing(session)
			}, jid)
		},
		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		},

		// Optimized direct access to LID mapping store
		lidMapping,

		async validateSession(jid: string) {
			try {
				const addr = jidToSignalProtocolAddress(jid)
				const session = await storage.loadSession(addr.toString())

				if (!session) {
					return { exists: false, reason: 'no session' }
				}

				if (!session.haveOpenSession()) {
					return { exists: false, reason: 'no open session' }
				}

				return { exists: true }
			} catch (error) {
				return { exists: false, reason: 'validation error' }
			}
		},

		async deleteSession(jids: string[]) {
			if (!jids.length) return

			// Convert JIDs to signal addresses and prepare for bulk deletion
			const sessionUpdates: { [key: string]: null } = {}
			jids.forEach(jid => {
				const addr = jidToSignalProtocolAddress(jid)
				sessionUpdates[addr.toString()] = null
			})

			// Single transaction for all deletions
			return parsedKeys.transaction(async () => {
				await auth.keys.set({ session: sessionUpdates })
			}, `delete-${jids.length}-sessions`)
		},

		async migrateSession(
			fromJid: string,
			toJid: string
		): Promise<{ migrated: number; skipped: number; total: number }> {
			// TODO: use usync to handle this entire mess
			if (!fromJid || !toJid.includes('@lid')) return { migrated: 0, skipped: 0, total: 0 }

			// Only support PN to LID migration
			if (!fromJid.includes('@s.whatsapp.net')) {
				return { migrated: 0, skipped: 0, total: 1 }
			}

			const { user } = jidDecode(fromJid)!

			logger.debug({ fromJid }, 'bulk device migration - loading all user devices')

			// Get user's device list from storage
			const { [user]: userDevices } = await parsedKeys.get('device-list', [user])
			if (!userDevices) {
				return { migrated: 0, skipped: 0, total: 0 }
			}

			const { device: fromDevice } = jidDecode(fromJid)!
			const fromDeviceStr = fromDevice?.toString() || '0'
			if (!userDevices.includes(fromDeviceStr)) {
				userDevices.push(fromDeviceStr)
			}

			// Filter out cached devices before database fetch
			const uncachedDevices = userDevices.filter(device => {
				const deviceKey = `${user}.${device}`
				return !migratedSessionCache.has(deviceKey)
			})

			// Bulk check session existence only for uncached devices
			const deviceSessionKeys = uncachedDevices.map(device => `${user}.${device}`)
			const existingSessions = await parsedKeys.get('session', deviceSessionKeys)

			// Step 3: Convert existing sessions to JIDs (only migrate sessions that exist)
			const deviceJids: string[] = []
			for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
				if (sessionData) {
					// Session exists in storage
					const deviceStr = sessionKey.split('.')[1]
					if (!deviceStr) continue
					const deviceNum = parseInt(deviceStr)
					const jid = deviceNum === 0 ? `${user}@s.whatsapp.net` : `${user}:${deviceNum}@s.whatsapp.net`
					deviceJids.push(jid)
				}
			}

			logger.debug(
				{
					fromJid,
					totalDevices: userDevices.length,
					devicesWithSessions: deviceJids.length,
					devices: deviceJids
				},
				'bulk device migration complete - all user devices processed'
			)

			// Single transaction for all migrations
			return parsedKeys.transaction(
				async (): Promise<{ migrated: number; skipped: number; total: number }> => {
					// Prepare migration operations with addressing metadata
					type MigrationOp = {
						fromJid: string
						toJid: string
						pnUser: string
						lidUser: string
						deviceId: number
						fromAddr: libsignal.ProtocolAddress
						toAddr: libsignal.ProtocolAddress
					}

					const migrationOps: MigrationOp[] = deviceJids.map(jid => {
						const lidWithDevice = transferDevice(jid, toJid)
						const fromDecoded = jidDecode(jid)!
						const toDecoded = jidDecode(lidWithDevice)!

						return {
							fromJid: jid,
							toJid: lidWithDevice,
							pnUser: fromDecoded.user,
							lidUser: toDecoded.user,
							deviceId: fromDecoded.device || 0,
							fromAddr: jidToSignalProtocolAddress(jid),
							toAddr: jidToSignalProtocolAddress(lidWithDevice)
						}
					})

					const totalOps = migrationOps.length
					let migratedCount = 0

					// Bulk fetch PN sessions - already exist (verified during device discovery)
					const pnAddrStrings = Array.from(new Set(migrationOps.map(op => op.fromAddr.toString())))
					const pnSessions = await parsedKeys.get('session', pnAddrStrings)

					// Prepare bulk session updates (PN → LID migration + deletion)
					const sessionUpdates: { [key: string]: Uint8Array | null } = {}

					for (const op of migrationOps) {
						const pnAddrStr = op.fromAddr.toString()
						const lidAddrStr = op.toAddr.toString()

						const pnSession = pnSessions[pnAddrStr]
						if (pnSession) {
							// Session exists (guaranteed from device discovery)
							const fromSession = libsignal.SessionRecord.deserialize(pnSession)
							if (fromSession.haveOpenSession()) {
								// Queue for bulk update: copy to LID, delete from PN
								sessionUpdates[lidAddrStr] = fromSession.serialize()
								sessionUpdates[pnAddrStr] = null

								migratedCount++
							}
						}
					}

					// Single bulk session update for all migrations
					if (Object.keys(sessionUpdates).length > 0) {
						await parsedKeys.set({ session: sessionUpdates })
						logger.debug({ migratedSessions: migratedCount }, 'bulk session migration complete')

						// Cache device-level migrations
						for (const op of migrationOps) {
							if (sessionUpdates[op.toAddr.toString()]) {
								const deviceKey = `${op.pnUser}.${op.deviceId}`
								migratedSessionCache.set(deviceKey, true)
							}
						}
					}

					const skippedCount = totalOps - migratedCount
					return { migrated: migratedCount, skipped: skippedCount, total: totalOps }
				},
				`migrate-${deviceJids.length}-sessions-${jidDecode(toJid)?.user}`
			)
		}
	}

	return repository
}

const jidToSignalProtocolAddress = (jid: string): libsignal.ProtocolAddress => {
	const decoded = jidDecode(jid)!
	const { user, device, server, domainType } = decoded

	if (!user) {
		throw new Error(
			`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`
		)
	}

	const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
	const finalDevice = device || 0

	if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
		throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid)
	}

	return new libsignal.ProtocolAddress(signalUser, finalDevice)
}

const jidToSignalSenderKeyName = (group: string, user: string): SenderKeyName => {
	return new SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage(
	{ creds, keys }: SignalAuthState,
	lidMapping: LIDMappingStore
): SenderKeyStore & libsignal.SignalStorage {
	// Shared function to resolve PN signal address to LID if mapping exists
	const resolveLIDSignalAddress = async (id: string): Promise<string> => {
		if (id.includes('.')) {
			const [deviceId, device] = id.split('.')
			const [user, domainType_] = deviceId!.split('_')
			const domainType = parseInt(domainType_ || '0')

			if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id

			const pnJid = `${user!}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`

			const lidForPN = await lidMapping.getLIDForPN(pnJid)
			if (lidForPN) {
				const lidAddr = jidToSignalProtocolAddress(lidForPN)
				return lidAddr.toString()
			}
		}

		return id
	}

	return {
		loadSession: async (id: string) => {
			try {
				const wireJid = await resolveLIDSignalAddress(id)
				const { [wireJid]: sess } = await keys.get('session', [wireJid])

				if (sess) {
					return libsignal.SessionRecord.deserialize(sess)
				}
			} catch (e) {
				return null
			}

			return null
		},
		storeSession: async (id: string, session: libsignal.SessionRecord) => {
			const wireJid = await resolveLIDSignalAddress(id)
			await keys.set({ session: { [wireJid]: session.serialize() } })
		},
		isTrustedIdentity: () => {
			return true // todo: implement
		},
		loadPreKey: async (id: number | string) => {
			const keyId = id.toString()
			const { [keyId]: key } = await keys.get('pre-key', [keyId])
			if (key) {
				return {
					privKey: Buffer.from(key.private),
					pubKey: Buffer.from(key.public)
				}
			}
		},
		removePreKey: (id: number) => keys.set({ 'pre-key': { [id]: null } }),
		loadSignedPreKey: () => {
			const key = creds.signedPreKey
			return {
				privKey: Buffer.from(key.keyPair.private),
				pubKey: Buffer.from(key.keyPair.public)
			}
		},
		loadSenderKey: async (senderKeyName: SenderKeyName) => {
			const keyId = senderKeyName.toString()
			const { [keyId]: key } = await keys.get('sender-key', [keyId])
			if (key) {
				return SenderKeyRecord.deserialize(key)
			}

			return new SenderKeyRecord()
		},
		storeSenderKey: async (senderKeyName: SenderKeyName, key: SenderKeyRecord) => {
			const keyId = senderKeyName.toString()
			const serialized = JSON.stringify(key.serialize())
			await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } })
		},
		getOurRegistrationId: () => creds.registrationId,
		getOurIdentity: () => {
			const { signedIdentityKey } = creds
			return {
				privKey: Buffer.from(signedIdentityKey.private),
				pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public))
			}
		}
	}
}



================================================
FILE: src/Signal/lid-mapping.ts
================================================
import { LRUCache } from 'lru-cache'
import type { LIDMapping, SignalKeyStoreWithTransaction } from '../Types'
import type { ILogger } from '../Utils/logger'
import {
	isHostedLidUser,
	isHostedPnUser,
	isLidUser,
	isPnUser,
	jidDecode,
	jidNormalizedUser,
	WAJIDDomains
} from '../WABinary'

export class LIDMappingStore {
	private readonly mappingCache = new LRUCache<string, string>({
		ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
		ttlAutopurge: true,
		updateAgeOnGet: true
	})
	private readonly keys: SignalKeyStoreWithTransaction
	private readonly logger: ILogger

	private pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>

	constructor(
		keys: SignalKeyStoreWithTransaction,
		logger: ILogger,
		pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>
	) {
		this.keys = keys
		this.pnToLIDFunc = pnToLIDFunc
		this.logger = logger
	}

	/**
	 * Store LID-PN mapping - USER LEVEL
	 */
	async storeLIDPNMappings(pairs: LIDMapping[]): Promise<void> {
		// Validate inputs
		const pairMap: { [_: string]: string } = {}
		for (const { lid, pn } of pairs) {
			if (!((isLidUser(lid) && isPnUser(pn)) || (isPnUser(lid) && isLidUser(pn)))) {
				this.logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`)
				continue
			}

			const lidDecoded = jidDecode(lid)
			const pnDecoded = jidDecode(pn)

			if (!lidDecoded || !pnDecoded) return

			const pnUser = pnDecoded.user
			const lidUser = lidDecoded.user

			let existingLidUser = this.mappingCache.get(`pn:${pnUser}`)
			if (!existingLidUser) {
				this.logger.trace(`Cache miss for PN user ${pnUser}; checking database`)
				const stored = await this.keys.get('lid-mapping', [pnUser])
				existingLidUser = stored[pnUser]
				if (existingLidUser) {
					// Update cache with database value
					this.mappingCache.set(`pn:${pnUser}`, existingLidUser)
					this.mappingCache.set(`lid:${existingLidUser}`, pnUser)
				}
			}

			if (existingLidUser === lidUser) {
				this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping')
				continue
			}

			pairMap[pnUser] = lidUser
		}

		this.logger.trace({ pairMap }, `Storing ${Object.keys(pairMap).length} pn mappings`)

		await this.keys.transaction(async () => {
			for (const [pnUser, lidUser] of Object.entries(pairMap)) {
				await this.keys.set({
					'lid-mapping': {
						[pnUser]: lidUser,
						[`${lidUser}_reverse`]: pnUser
					}
				})

				this.mappingCache.set(`pn:${pnUser}`, lidUser)
				this.mappingCache.set(`lid:${lidUser}`, pnUser)
			}
		}, 'lid-mapping')
	}

	/**
	 * Get LID for PN - Returns device-specific LID based on user mapping
	 */
	async getLIDForPN(pn: string): Promise<string | null> {
		return (await this.getLIDsForPNs([pn]))?.[0]?.lid || null
	}

	async getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null> {
		const usyncFetch: { [_: string]: number[] } = {}
		// mapped from pn to lid mapping to prevent duplication in results later
		const successfulPairs: { [_: string]: LIDMapping } = {}
		for (const pn of pns) {
			if (!isPnUser(pn) && !isHostedPnUser(pn)) continue

			const decoded = jidDecode(pn)
			if (!decoded) continue

			// Check cache first for PN → LID mapping
			const pnUser = decoded.user
			let lidUser = this.mappingCache.get(`pn:${pnUser}`)

			if (!lidUser) {
				// Cache miss - check database
				const stored = await this.keys.get('lid-mapping', [pnUser])
				lidUser = stored[pnUser]

				if (lidUser) {
					this.mappingCache.set(`pn:${pnUser}`, lidUser)
					this.mappingCache.set(`lid:${lidUser}`, pnUser)
				} else {
					this.logger.trace(`No LID mapping found for PN user ${pnUser}; batch getting from USync`)
					const device = decoded.device || 0
					let normalizedPn = jidNormalizedUser(pn)
					if (isHostedLidUser(normalizedPn) || isHostedPnUser(normalizedPn)) {
						normalizedPn = `${pnUser}@s.whatsapp.net`
					}

					if (!usyncFetch[normalizedPn]) {
						usyncFetch[normalizedPn] = [device]
					} else {
						usyncFetch[normalizedPn]?.push(device)
					}

					continue
				}
			}

			lidUser = lidUser.toString()
			if (!lidUser) {
				this.logger.warn(`Invalid or empty LID user for PN ${pn}: lidUser = "${lidUser}"`)
				return null
			}

			// Push the PN device ID to the LID to maintain device separation
			const pnDevice = decoded.device !== undefined ? decoded.device : 0
			const deviceSpecificLid = `${lidUser}${!!pnDevice ? `:${pnDevice}` : ``}@${decoded.server === 'hosted' ? 'hosted.lid' : 'lid'}`

			this.logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid} (user mapping with device ${pnDevice})`)
			successfulPairs[pn] = { lid: deviceSpecificLid, pn }
		}

		if (Object.keys(usyncFetch).length > 0) {
			const result = await this.pnToLIDFunc?.(Object.keys(usyncFetch)) // this function already adds LIDs to mapping
			if (result && result.length > 0) {
				this.storeLIDPNMappings(result)
				for (const pair of result) {
					const pnDecoded = jidDecode(pair.pn)
					const pnUser = pnDecoded?.user
					if (!pnUser) continue
					const lidUser = jidDecode(pair.lid)?.user
					if (!lidUser) continue

					for (const device of usyncFetch[pair.pn]!) {
						const deviceSpecificLid = `${lidUser}${!!device ? `:${device}` : ``}@${device === 99 ? 'hosted.lid' : 'lid'}`

						this.logger.trace(
							`getLIDForPN: USYNC success for ${pair.pn} → ${deviceSpecificLid} (user mapping with device ${device})`
						)

						const deviceSpecificPn = `${pnUser}${!!device ? `:${device}` : ``}@${device === 99 ? 'hosted' : 's.whatsapp.net'}`

						successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn }
					}
				}
			} else {
				return null
			}
		}

		return Object.values(successfulPairs)
	}

	/**
	 * Get PN for LID - USER LEVEL with device construction
	 */
	async getPNForLID(lid: string): Promise<string | null> {
		if (!isLidUser(lid)) return null

		const decoded = jidDecode(lid)
		if (!decoded) return null

		// Check cache first for LID → PN mapping
		const lidUser = decoded.user
		let pnUser = this.mappingCache.get(`lid:${lidUser}`)

		if (!pnUser || typeof pnUser !== 'string') {
			// Cache miss - check database
			const stored = await this.keys.get('lid-mapping', [`${lidUser}_reverse`])
			pnUser = stored[`${lidUser}_reverse`]

			if (!pnUser || typeof pnUser !== 'string') {
				this.logger.trace(`No reverse mapping found for LID user: ${lidUser}`)
				return null
			}

			this.mappingCache.set(`lid:${lidUser}`, pnUser)
		}

		// Construct device-specific PN JID
		const lidDevice = decoded.device !== undefined ? decoded.device : 0
		const pnJid = `${pnUser}:${lidDevice}@${decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'}`

		this.logger.trace(`Found reverse mapping: ${lid} → ${pnJid}`)
		return pnJid
	}
}



================================================
FILE: src/Signal/Group/ciphertext-message.ts
================================================
export class CiphertextMessage {
	readonly UNSUPPORTED_VERSION: number = 1
	readonly CURRENT_VERSION: number = 3
	readonly WHISPER_TYPE: number = 2
	readonly PREKEY_TYPE: number = 3
	readonly SENDERKEY_TYPE: number = 4
	readonly SENDERKEY_DISTRIBUTION_TYPE: number = 5
	readonly ENCRYPTED_MESSAGE_OVERHEAD: number = 53
}



================================================
FILE: src/Signal/Group/group-session-builder.ts
================================================
import * as keyhelper from './keyhelper'
import { SenderKeyDistributionMessage } from './sender-key-distribution-message'
import { SenderKeyName } from './sender-key-name'
import { SenderKeyRecord } from './sender-key-record'

interface SenderKeyStore {
	loadSenderKey(senderKeyName: SenderKeyName): Promise<SenderKeyRecord>
	storeSenderKey(senderKeyName: SenderKeyName, record: SenderKeyRecord): Promise<void>
}

export class GroupSessionBuilder {
	private readonly senderKeyStore: SenderKeyStore

	constructor(senderKeyStore: SenderKeyStore) {
		this.senderKeyStore = senderKeyStore
	}

	public async process(
		senderKeyName: SenderKeyName,
		senderKeyDistributionMessage: SenderKeyDistributionMessage
	): Promise<void> {
		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)
		senderKeyRecord.addSenderKeyState(
			senderKeyDistributionMessage.getId(),
			senderKeyDistributionMessage.getIteration(),
			senderKeyDistributionMessage.getChainKey(),
			senderKeyDistributionMessage.getSignatureKey()
		)
		await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
	}

	public async create(senderKeyName: SenderKeyName): Promise<SenderKeyDistributionMessage> {
		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)

		if (senderKeyRecord.isEmpty()) {
			const keyId = keyhelper.generateSenderKeyId()
			const senderKey = keyhelper.generateSenderKey()
			const signingKey = keyhelper.generateSenderSigningKey()

			senderKeyRecord.setSenderKeyState(keyId, 0, senderKey, signingKey)
			await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
		}

		const state = senderKeyRecord.getSenderKeyState()
		if (!state) {
			throw new Error('No session state available')
		}

		return new SenderKeyDistributionMessage(
			state.getKeyId(),
			state.getSenderChainKey().getIteration(),
			state.getSenderChainKey().getSeed(),
			state.getSigningKeyPublic()
		)
	}
}



================================================
FILE: src/Signal/Group/group_cipher.ts
================================================
import { decrypt, encrypt } from 'libsignal/src/crypto'
import { SenderKeyMessage } from './sender-key-message'
import { SenderKeyName } from './sender-key-name'
import { SenderKeyRecord } from './sender-key-record'
import { SenderKeyState } from './sender-key-state'

export interface SenderKeyStore {
	loadSenderKey(senderKeyName: SenderKeyName): Promise<SenderKeyRecord>

	storeSenderKey(senderKeyName: SenderKeyName, record: SenderKeyRecord): Promise<void>
}

export class GroupCipher {
	private readonly senderKeyStore: SenderKeyStore
	private readonly senderKeyName: SenderKeyName

	constructor(senderKeyStore: SenderKeyStore, senderKeyName: SenderKeyName) {
		this.senderKeyStore = senderKeyStore
		this.senderKeyName = senderKeyName
	}

	public async encrypt(paddedPlaintext: Uint8Array): Promise<Uint8Array> {
		const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
		if (!record) {
			throw new Error('No SenderKeyRecord found for encryption')
		}

		const senderKeyState = record.getSenderKeyState()
		if (!senderKeyState) {
			throw new Error('No session to encrypt message')
		}

		const iteration = senderKeyState.getSenderChainKey().getIteration()
		const senderKey = this.getSenderKey(senderKeyState, iteration === 0 ? 0 : iteration + 1)

		const ciphertext = await this.getCipherText(senderKey.getIv(), senderKey.getCipherKey(), paddedPlaintext)

		const senderKeyMessage = new SenderKeyMessage(
			senderKeyState.getKeyId(),
			senderKey.getIteration(),
			ciphertext,
			senderKeyState.getSigningKeyPrivate()
		)

		await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
		return senderKeyMessage.serialize()
	}

	public async decrypt(senderKeyMessageBytes: Uint8Array): Promise<Uint8Array> {
		const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
		if (!record) {
			throw new Error('No SenderKeyRecord found for decryption')
		}

		const senderKeyMessage = new SenderKeyMessage(null, null, null, null, senderKeyMessageBytes)
		const senderKeyState = record.getSenderKeyState(senderKeyMessage.getKeyId())
		if (!senderKeyState) {
			throw new Error('No session found to decrypt message')
		}

		senderKeyMessage.verifySignature(senderKeyState.getSigningKeyPublic())
		const senderKey = this.getSenderKey(senderKeyState, senderKeyMessage.getIteration())

		const plaintext = await this.getPlainText(
			senderKey.getIv(),
			senderKey.getCipherKey(),
			senderKeyMessage.getCipherText()
		)

		await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
		return plaintext
	}

	private getSenderKey(senderKeyState: SenderKeyState, iteration: number) {
		let senderChainKey = senderKeyState.getSenderChainKey()
		if (senderChainKey.getIteration() > iteration) {
			if (senderKeyState.hasSenderMessageKey(iteration)) {
				const messageKey = senderKeyState.removeSenderMessageKey(iteration)
				if (!messageKey) {
					throw new Error('No sender message key found for iteration')
				}

				return messageKey
			}

			throw new Error(`Received message with old counter: ${senderChainKey.getIteration()}, ${iteration}`)
		}

		if (iteration - senderChainKey.getIteration() > 2000) {
			throw new Error('Over 2000 messages into the future!')
		}

		while (senderChainKey.getIteration() < iteration) {
			senderKeyState.addSenderMessageKey(senderChainKey.getSenderMessageKey())
			senderChainKey = senderChainKey.getNext()
		}

		senderKeyState.setSenderChainKey(senderChainKey.getNext())
		return senderChainKey.getSenderMessageKey()
	}

	private async getPlainText(iv: Uint8Array, key: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
		try {
			return decrypt(key, ciphertext, iv)
		} catch (e) {
			throw new Error('InvalidMessageException')
		}
	}

	private async getCipherText(iv: Uint8Array, key: Uint8Array, plaintext: Uint8Array): Promise<Buffer> {
		try {
			return encrypt(key, plaintext, iv)
		} catch (e) {
			throw new Error('InvalidMessageException')
		}
	}
}



================================================
FILE: src/Signal/Group/index.ts
================================================
export { GroupSessionBuilder } from './group-session-builder'
export { SenderKeyDistributionMessage } from './sender-key-distribution-message'
export { SenderKeyRecord } from './sender-key-record'
export { SenderKeyName } from './sender-key-name'
export { GroupCipher } from './group_cipher'
export { SenderKeyState } from './sender-key-state'
export { SenderKeyMessage } from './sender-key-message'
export { SenderMessageKey } from './sender-message-key'
export { SenderChainKey } from './sender-chain-key'
export { CiphertextMessage } from './ciphertext-message'
export * as keyhelper from './keyhelper'



================================================
FILE: src/Signal/Group/keyhelper.ts
================================================
import * as nodeCrypto from 'crypto'
import { generateKeyPair } from 'libsignal/src/curve'

type KeyPairType = ReturnType<typeof generateKeyPair>

export function generateSenderKey(): Buffer {
	return nodeCrypto.randomBytes(32)
}

export function generateSenderKeyId(): number {
	return nodeCrypto.randomInt(2147483647)
}

export interface SigningKeyPair {
	public: Buffer
	private: Buffer
}

export function generateSenderSigningKey(key?: KeyPairType): SigningKeyPair {
	if (!key) {
		key = generateKeyPair()
	}

	return {
		public: Buffer.from(key.pubKey),
		private: Buffer.from(key.privKey)
	}
}



================================================
FILE: src/Signal/Group/sender-chain-key.ts
================================================
import { calculateMAC } from 'libsignal/src/crypto'
import { SenderMessageKey } from './sender-message-key'

export class SenderChainKey {
	private readonly MESSAGE_KEY_SEED: Uint8Array = Buffer.from([0x01])
	private readonly CHAIN_KEY_SEED: Uint8Array = Buffer.from([0x02])
	private readonly iteration: number
	private readonly chainKey: Buffer

	constructor(iteration: number, chainKey: Uint8Array | Buffer) {
		this.iteration = iteration
		this.chainKey = Buffer.from(chainKey)
	}

	public getIteration(): number {
		return this.iteration
	}

	public getSenderMessageKey(): SenderMessageKey {
		return new SenderMessageKey(this.iteration, this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey))
	}

	public getNext(): SenderChainKey {
		return new SenderChainKey(this.iteration + 1, this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey))
	}

	public getSeed(): Uint8Array {
		return this.chainKey
	}

	private getDerivative(seed: Uint8Array, key: Buffer): Uint8Array {
		return calculateMAC(key, seed)
	}
}



================================================
FILE: src/Signal/Group/sender-key-distribution-message.ts
================================================
import { proto } from '../../../WAProto/index.js'
import { CiphertextMessage } from './ciphertext-message'

interface SenderKeyDistributionMessageStructure {
	id: number
	iteration: number
	chainKey: string | Uint8Array
	signingKey: string | Uint8Array
}

export class SenderKeyDistributionMessage extends CiphertextMessage {
	private readonly id: number
	private readonly iteration: number
	private readonly chainKey: Uint8Array
	private readonly signatureKey: Uint8Array
	private readonly serialized: Uint8Array

	constructor(
		id?: number | null,
		iteration?: number | null,
		chainKey?: Uint8Array | null,
		signatureKey?: Uint8Array | null,
		serialized?: Uint8Array | null
	) {
		super()

		if (serialized) {
			try {
				const message = serialized.slice(1)
				const distributionMessage = proto.SenderKeyDistributionMessage.decode(
					message
				).toJSON() as SenderKeyDistributionMessageStructure

				this.serialized = serialized
				this.id = distributionMessage.id
				this.iteration = distributionMessage.iteration
				this.chainKey =
					typeof distributionMessage.chainKey === 'string'
						? Buffer.from(distributionMessage.chainKey, 'base64')
						: distributionMessage.chainKey
				this.signatureKey =
					typeof distributionMessage.signingKey === 'string'
						? Buffer.from(distributionMessage.signingKey, 'base64')
						: distributionMessage.signingKey
			} catch (e) {
				throw new Error(String(e))
			}
		} else {
			const version = this.intsToByteHighAndLow(this.CURRENT_VERSION, this.CURRENT_VERSION)
			this.id = id!
			this.iteration = iteration!
			this.chainKey = chainKey!
			this.signatureKey = signatureKey!

			const message = proto.SenderKeyDistributionMessage.encode(
				proto.SenderKeyDistributionMessage.create({
					id,
					iteration,
					chainKey,
					signingKey: this.signatureKey
				})
			).finish()

			this.serialized = Buffer.concat([Buffer.from([version]), message])
		}
	}

	private intsToByteHighAndLow(highValue: number, lowValue: number): number {
		return (((highValue << 4) | lowValue) & 0xff) % 256
	}

	public serialize(): Uint8Array {
		return this.serialized
	}

	public getType(): number {
		return this.SENDERKEY_DISTRIBUTION_TYPE
	}

	public getIteration(): number {
		return this.iteration
	}

	public getChainKey(): Uint8Array {
		return this.chainKey
	}

	public getSignatureKey(): Uint8Array {
		return this.signatureKey
	}

	public getId(): number {
		return this.id
	}
}



================================================
FILE: src/Signal/Group/sender-key-message.ts
================================================
import { calculateSignature, verifySignature } from 'libsignal/src/curve'
import { proto } from '../../../WAProto/index.js'
import { CiphertextMessage } from './ciphertext-message'

interface SenderKeyMessageStructure {
	id: number
	iteration: number
	ciphertext: string | Buffer
}

export class SenderKeyMessage extends CiphertextMessage {
	private readonly SIGNATURE_LENGTH = 64
	private readonly messageVersion: number
	private readonly keyId: number
	private readonly iteration: number
	private readonly ciphertext: Uint8Array
	private readonly signature: Uint8Array
	private readonly serialized: Uint8Array

	constructor(
		keyId?: number | null,
		iteration?: number | null,
		ciphertext?: Uint8Array | null,
		signatureKey?: Uint8Array | null,
		serialized?: Uint8Array | null
	) {
		super()

		if (serialized) {
			const version = serialized[0]!
			const message = serialized.slice(1, serialized.length - this.SIGNATURE_LENGTH)
			const signature = serialized.slice(-1 * this.SIGNATURE_LENGTH)
			const senderKeyMessage = proto.SenderKeyMessage.decode(message).toJSON() as SenderKeyMessageStructure

			this.serialized = serialized
			this.messageVersion = (version & 0xff) >> 4
			this.keyId = senderKeyMessage.id
			this.iteration = senderKeyMessage.iteration
			this.ciphertext =
				typeof senderKeyMessage.ciphertext === 'string'
					? Buffer.from(senderKeyMessage.ciphertext, 'base64')
					: senderKeyMessage.ciphertext
			this.signature = signature
		} else {
			const version = (((this.CURRENT_VERSION << 4) | this.CURRENT_VERSION) & 0xff) % 256
			const ciphertextBuffer = Buffer.from(ciphertext!)
			const message = proto.SenderKeyMessage.encode(
				proto.SenderKeyMessage.create({
					id: keyId!,
					iteration: iteration!,
					ciphertext: ciphertextBuffer
				})
			).finish()

			const signature = this.getSignature(signatureKey!, Buffer.concat([Buffer.from([version]), message]))

			this.serialized = Buffer.concat([Buffer.from([version]), message, Buffer.from(signature)])
			this.messageVersion = this.CURRENT_VERSION
			this.keyId = keyId!
			this.iteration = iteration!
			this.ciphertext = ciphertextBuffer
			this.signature = signature
		}
	}

	public getKeyId(): number {
		return this.keyId
	}

	public getIteration(): number {
		return this.iteration
	}

	public getCipherText(): Uint8Array {
		return this.ciphertext
	}

	public verifySignature(signatureKey: Uint8Array): void {
		const part1 = this.serialized.slice(0, this.serialized.length - this.SIGNATURE_LENGTH)
		const part2 = this.serialized.slice(-1 * this.SIGNATURE_LENGTH)
		const res = verifySignature(signatureKey, part1, part2)
		if (!res) throw new Error('Invalid signature!')
	}

	private getSignature(signatureKey: Uint8Array, serialized: Uint8Array): Uint8Array {
		return Buffer.from(calculateSignature(signatureKey, serialized))
	}

	public serialize(): Uint8Array {
		return this.serialized
	}

	public getType(): number {
		return 4
	}
}



================================================
FILE: src/Signal/Group/sender-key-name.ts
================================================
interface Sender {
	id: string
	deviceId: number
	toString(): string
}

function isNull(str: string | null): boolean {
	return str === null || str === ''
}

function intValue(num: number): number {
	const MAX_VALUE = 0x7fffffff
	const MIN_VALUE = -0x80000000
	if (num > MAX_VALUE || num < MIN_VALUE) {
		return num & 0xffffffff
	}

	return num
}

function hashCode(strKey: string): number {
	let hash = 0
	if (!isNull(strKey)) {
		for (let i = 0; i < strKey.length; i++) {
			hash = hash * 31 + strKey.charCodeAt(i)
			hash = intValue(hash)
		}
	}

	return hash
}

export class SenderKeyName {
	private readonly groupId: string
	private readonly sender: Sender

	constructor(groupId: string, sender: Sender) {
		this.groupId = groupId
		this.sender = sender
	}

	public getGroupId(): string {
		return this.groupId
	}

	public getSender(): Sender {
		return this.sender
	}

	public serialize(): string {
		return `${this.groupId}::${this.sender.id}::${this.sender.deviceId}`
	}

	public toString(): string {
		return this.serialize()
	}

	public equals(other: SenderKeyName | null): boolean {
		if (other === null) return false
		return this.groupId === other.groupId && this.sender.toString() === other.sender.toString()
	}

	public hashCode(): number {
		return hashCode(this.groupId) ^ hashCode(this.sender.toString())
	}
}



================================================
FILE: src/Signal/Group/sender-key-record.ts
================================================
import { BufferJSON } from '../../Utils/generics'
import { SenderKeyState } from './sender-key-state'

export interface SenderKeyStateStructure {
	senderKeyId: number
	senderChainKey: {
		iteration: number
		seed: Uint8Array
	}
	senderSigningKey: {
		public: Uint8Array
		private?: Uint8Array
	}
	senderMessageKeys: Array<{
		iteration: number
		seed: Uint8Array
	}>
}

export class SenderKeyRecord {
	private readonly MAX_STATES = 5
	private readonly senderKeyStates: SenderKeyState[] = []

	constructor(serialized?: SenderKeyStateStructure[]) {
		if (serialized) {
			for (const structure of serialized) {
				this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, structure))
			}
		}
	}

	public isEmpty(): boolean {
		return this.senderKeyStates.length === 0
	}

	public getSenderKeyState(keyId?: number): SenderKeyState | undefined {
		if (keyId === undefined && this.senderKeyStates.length) {
			return this.senderKeyStates[this.senderKeyStates.length - 1]
		}

		return this.senderKeyStates.find(state => state.getKeyId() === keyId)
	}

	public addSenderKeyState(id: number, iteration: number, chainKey: Uint8Array, signatureKey: Uint8Array): void {
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, null, signatureKey))
		if (this.senderKeyStates.length > this.MAX_STATES) {
			this.senderKeyStates.shift()
		}
	}

	public setSenderKeyState(
		id: number,
		iteration: number,
		chainKey: Uint8Array,
		keyPair: { public: Uint8Array; private: Uint8Array }
	): void {
		this.senderKeyStates.length = 0
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, keyPair))
	}

	public serialize(): SenderKeyStateStructure[] {
		return this.senderKeyStates.map(state => state.getStructure())
	}
	static deserialize(data: Uint8Array): SenderKeyRecord {
		const str = Buffer.from(data).toString('utf-8')
		const parsed = JSON.parse(str, BufferJSON.reviver)
		return new SenderKeyRecord(parsed)
	}
}



================================================
FILE: src/Signal/Group/sender-key-state.ts
================================================
import { SenderChainKey } from './sender-chain-key'
import { SenderMessageKey } from './sender-message-key'

interface SenderChainKeyStructure {
	iteration: number
	seed: Uint8Array
}

interface SenderSigningKeyStructure {
	public: Uint8Array
	private?: Uint8Array
}

interface SenderMessageKeyStructure {
	iteration: number
	seed: Uint8Array
}

interface SenderKeyStateStructure {
	senderKeyId: number
	senderChainKey: SenderChainKeyStructure
	senderSigningKey: SenderSigningKeyStructure
	senderMessageKeys: SenderMessageKeyStructure[]
}

export class SenderKeyState {
	private readonly MAX_MESSAGE_KEYS = 2000
	private readonly senderKeyStateStructure: SenderKeyStateStructure

	constructor(
		id?: number | null,
		iteration?: number | null,
		chainKey?: Uint8Array | null | string,
		signatureKeyPair?: { public: Uint8Array | string; private: Uint8Array | string } | null,
		signatureKeyPublic?: Uint8Array | string | null,
		signatureKeyPrivate?: Uint8Array | string | null,
		senderKeyStateStructure?: SenderKeyStateStructure | null
	) {
		if (senderKeyStateStructure) {
			this.senderKeyStateStructure = {
				...senderKeyStateStructure,
				senderMessageKeys: Array.isArray(senderKeyStateStructure.senderMessageKeys)
					? senderKeyStateStructure.senderMessageKeys
					: []
			}
		} else {
			if (signatureKeyPair) {
				signatureKeyPublic = signatureKeyPair.public
				signatureKeyPrivate = signatureKeyPair.private
			}

			this.senderKeyStateStructure = {
				senderKeyId: id || 0,
				senderChainKey: {
					iteration: iteration || 0,
					seed: Buffer.from(chainKey || [])
				},
				senderSigningKey: {
					public: Buffer.from(signatureKeyPublic || []),
					private: Buffer.from(signatureKeyPrivate || [])
				},
				senderMessageKeys: []
			}
		}
	}

	public getKeyId(): number {
		return this.senderKeyStateStructure.senderKeyId
	}

	public getSenderChainKey(): SenderChainKey {
		return new SenderChainKey(
			this.senderKeyStateStructure.senderChainKey.iteration,
			this.senderKeyStateStructure.senderChainKey.seed
		)
	}

	public setSenderChainKey(chainKey: SenderChainKey): void {
		this.senderKeyStateStructure.senderChainKey = {
			iteration: chainKey.getIteration(),
			seed: chainKey.getSeed()
		}
	}

	public getSigningKeyPublic(): Buffer {
		const publicKey = Buffer.from(this.senderKeyStateStructure.senderSigningKey.public)

		if (publicKey.length === 32) {
			const fixed = Buffer.alloc(33)
			fixed[0] = 0x05
			publicKey.copy(fixed, 1)
			return fixed
		}

		return publicKey
	}

	public getSigningKeyPrivate(): Buffer | undefined {
		const privateKey = this.senderKeyStateStructure.senderSigningKey.private

		return Buffer.from(privateKey || [])
	}

	public hasSenderMessageKey(iteration: number): boolean {
		return this.senderKeyStateStructure.senderMessageKeys.some(key => key.iteration === iteration)
	}

	public addSenderMessageKey(senderMessageKey: SenderMessageKey): void {
		this.senderKeyStateStructure.senderMessageKeys.push({
			iteration: senderMessageKey.getIteration(),
			seed: senderMessageKey.getSeed()
		})

		if (this.senderKeyStateStructure.senderMessageKeys.length > this.MAX_MESSAGE_KEYS) {
			this.senderKeyStateStructure.senderMessageKeys.shift()
		}
	}

	public removeSenderMessageKey(iteration: number): SenderMessageKey | null {
		const index = this.senderKeyStateStructure.senderMessageKeys.findIndex(key => key.iteration === iteration)

		if (index !== -1) {
			const messageKey = this.senderKeyStateStructure.senderMessageKeys[index]!
			this.senderKeyStateStructure.senderMessageKeys.splice(index, 1)
			return new SenderMessageKey(messageKey.iteration, messageKey.seed)
		}

		return null
	}

	public getStructure(): SenderKeyStateStructure {
		return this.senderKeyStateStructure
	}
}



================================================
FILE: src/Signal/Group/sender-message-key.ts
================================================
import { deriveSecrets } from 'libsignal/src/crypto'

export class SenderMessageKey {
	private readonly iteration: number
	private readonly iv: Uint8Array
	private readonly cipherKey: Uint8Array
	private readonly seed: Uint8Array

	constructor(iteration: number, seed: Uint8Array) {
		const derivative = deriveSecrets(seed, Buffer.alloc(32), Buffer.from('WhisperGroup'))
		const keys = new Uint8Array(32)
		keys.set(new Uint8Array(derivative[0].slice(16)))
		keys.set(new Uint8Array(derivative[1].slice(0, 16)), 16)

		this.iv = Buffer.from(derivative[0].slice(0, 16))
		this.cipherKey = Buffer.from(keys.buffer)
		this.iteration = iteration
		this.seed = seed
	}

	public getIteration(): number {
		return this.iteration
	}

	public getIv(): Uint8Array {
		return this.iv
	}

	public getCipherKey(): Uint8Array {
		return this.cipherKey
	}

	public getSeed(): Uint8Array {
		return this.seed
	}
}



================================================
FILE: src/Socket/business.ts
================================================
import type { GetCatalogOptions, ProductCreate, ProductUpdate, SocketConfig, WAMediaUpload } from '../Types'
import type { UpdateBussinesProfileProps } from '../Types/Bussines'
import { getRawMediaUploadData } from '../Utils'
import {
	parseCatalogNode,
	parseCollectionsNode,
	parseOrderDetailsNode,
	parseProductNode,
	toProductNode,
	uploadingNecessaryImagesOfProduct
} from '../Utils/business'
import { type BinaryNode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { getBinaryNodeChild } from '../WABinary/generic-utils'
import { makeMessagesRecvSocket } from './messages-recv'

export const makeBusinessSocket = (config: SocketConfig) => {
	const sock = makeMessagesRecvSocket(config)
	const { authState, query, waUploadToServer } = sock

	const updateBussinesProfile = async (args: UpdateBussinesProfileProps) => {
		const node: BinaryNode[] = []
		const simpleFields: (keyof UpdateBussinesProfileProps)[] = ['address', 'email', 'description']

		node.push(
			...simpleFields
				.filter(key => args[key])
				.map(key => ({
					tag: key,
					attrs: {},
					content: args[key] as string
				}))
		)

		if (args.websites) {
			node.push(
				...args.websites.map(website => ({
					tag: 'website',
					attrs: {},
					content: website
				}))
			)
		}

		if (args.hours) {
			node.push({
				tag: 'business_hours',
				attrs: { timezone: args.hours.timezone },
				content: args.hours.days.map(config => {
					const base = {
						tag: 'business_hours_config',
						attrs: { day_of_week: config.day, mode: config.mode }
					}

					if (config.mode === 'specific_hours') {
						return {
							...base,
							attrs: {
								...base.attrs,
								open_time: config.openTimeInMinutes,
								close_time: config.closeTimeInMinutes
							}
						}
					}

					return base
				})
			})
		}

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: node
				}
			]
		})

		return result
	}

	const updateCoverPhoto = async (photo: WAMediaUpload) => {
		const { fileSha256, filePath } = await getRawMediaUploadData(photo, 'biz-cover-photo')
		const fileSha256B64 = fileSha256.toString('base64')

		const { meta_hmac, fbid, ts } = await waUploadToServer(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType: 'biz-cover-photo'
		})

		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: [
						{
							tag: 'cover_photo',
							attrs: { id: String(fbid), op: 'update', token: meta_hmac!, ts: String(ts) }
						}
					]
				}
			]
		})

		return fbid!
	}

	const removeCoverPhoto = async (id: string) => {
		return await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: [
						{
							tag: 'cover_photo',
							attrs: { op: 'delete', id }
						}
					]
				}
			]
		})
	}

	const getCatalog = async ({ jid, limit, cursor }: GetCatalogOptions) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)

		const queryParamNodes: BinaryNode[] = [
			{
				tag: 'limit',
				attrs: {},
				content: Buffer.from((limit || 10).toString())
			},
			{
				tag: 'width',
				attrs: {},
				content: Buffer.from('100')
			},
			{
				tag: 'height',
				attrs: {},
				content: Buffer.from('100')
			}
		]

		if (cursor) {
			queryParamNodes.push({
				tag: 'after',
				attrs: {},
				content: cursor
			})
		}

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog',
					attrs: {
						jid,
						allow_shop_source: 'true'
					},
					content: queryParamNodes
				}
			]
		})
		return parseCatalogNode(result)
	}

	const getCollections = async (jid?: string, limit = 51) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'w:biz:catalog',
				smax_id: '35'
			},
			content: [
				{
					tag: 'collections',
					attrs: {
						biz_jid: jid
					},
					content: [
						{
							tag: 'collection_limit',
							attrs: {},
							content: Buffer.from(limit.toString())
						},
						{
							tag: 'item_limit',
							attrs: {},
							content: Buffer.from(limit.toString())
						},
						{
							tag: 'width',
							attrs: {},
							content: Buffer.from('100')
						},
						{
							tag: 'height',
							attrs: {},
							content: Buffer.from('100')
						}
					]
				}
			]
		})

		return parseCollectionsNode(result)
	}

	const getOrderDetails = async (orderId: string, tokenBase64: string) => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'fb:thrift_iq',
				smax_id: '5'
			},
			content: [
				{
					tag: 'order',
					attrs: {
						op: 'get',
						id: orderId
					},
					content: [
						{
							tag: 'image_dimensions',
							attrs: {},
							content: [
								{
									tag: 'width',
									attrs: {},
									content: Buffer.from('100')
								},
								{
									tag: 'height',
									attrs: {},
									content: Buffer.from('100')
								}
							]
						},
						{
							tag: 'token',
							attrs: {},
							content: Buffer.from(tokenBase64)
						}
					]
				}
			]
		})

		return parseOrderDetailsNode(result)
	}

	const productUpdate = async (productId: string, update: ProductUpdate) => {
		update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer)
		const editNode = toProductNode(productId, update)

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_edit',
					attrs: { v: '1' },
					content: [
						editNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})

		const productCatalogEditNode = getBinaryNodeChild(result, 'product_catalog_edit')
		const productNode = getBinaryNodeChild(productCatalogEditNode, 'product')

		return parseProductNode(productNode!)
	}

	const productCreate = async (create: ProductCreate) => {
		// ensure isHidden is defined
		create.isHidden = !!create.isHidden
		create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer)
		const createNode = toProductNode(undefined, create)

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_add',
					attrs: { v: '1' },
					content: [
						createNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})

		const productCatalogAddNode = getBinaryNodeChild(result, 'product_catalog_add')
		const productNode = getBinaryNodeChild(productCatalogAddNode, 'product')

		return parseProductNode(productNode!)
	}

	const productDelete = async (productIds: string[]) => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_delete',
					attrs: { v: '1' },
					content: productIds.map(id => ({
						tag: 'product',
						attrs: {},
						content: [
							{
								tag: 'id',
								attrs: {},
								content: Buffer.from(id)
							}
						]
					}))
				}
			]
		})

		const productCatalogDelNode = getBinaryNodeChild(result, 'product_catalog_delete')
		return {
			deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
		}
	}

	return {
		...sock,
		logger: config.logger,
		getOrderDetails,
		getCatalog,
		getCollections,
		productCreate,
		productDelete,
		productUpdate,
		updateBussinesProfile,
		updateCoverPhoto,
		removeCoverPhoto
	}
}



================================================
FILE: src/Socket/chats.ts
================================================
import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, PROCESSABLE_HISTORY_TYPES } from '../Defaults'
import type {
	BotListInfo,
	CacheStore,
	ChatModification,
	ChatMutation,
	LTHashState,
	MessageUpsertType,
	PresenceData,
	SocketConfig,
	WABusinessHoursConfig,
	WABusinessProfile,
	WAMediaUpload,
	WAMessage,
	WAPatchCreate,
	WAPatchName,
	WAPresence,
	WAPrivacyCallValue,
	WAPrivacyGroupAddValue,
	WAPrivacyMessagesValue,
	WAPrivacyOnlineValue,
	WAPrivacyValue,
	WAReadReceiptsValue
} from '../Types'
import { ALL_WA_PATCH_NAMES } from '../Types'
import type { QuickReplyAction } from '../Types/Bussines.js'
import type { LabelActionBody } from '../Types/Label'
import { SyncState } from '../Types/State'
import {
	chatModificationToAppPatch,
	type ChatMutationMap,
	decodePatches,
	decodeSyncdSnapshot,
	encodeSyncdPatch,
	extractSyncdPatches,
	generateProfilePicture,
	getHistoryMsg,
	newLTHashState,
	processSyncAction
} from '../Utils'
import { makeMutex } from '../Utils/make-mutex'
import processMessage from '../Utils/process-message'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	jidDecode,
	jidNormalizedUser,
	reduceBinaryNodeToDictionary,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { makeSocket } from './socket.js'
const MAX_SYNC_ATTEMPTS = 2

export const makeChatsSocket = (config: SocketConfig) => {
	const {
		logger,
		markOnlineOnConnect,
		fireInitQueries,
		appStateMacVerification,
		shouldIgnoreJid,
		shouldSyncHistoryMessage
	} = config
	const sock = makeSocket(config)
	const { ev, ws, authState, generateMessageTag, sendNode, query, signalRepository, onUnexpectedError } = sock

	let privacySettings: { [_: string]: string } | undefined

	let syncState: SyncState = SyncState.Connecting
	/** this mutex ensures that the notifications (receipts, messages etc.) are processed in order */
	const processingMutex = makeMutex()

	// Timeout for AwaitingInitialSync state
	let awaitingSyncTimeout: NodeJS.Timeout | undefined

	const placeholderResendCache =
		config.placeholderResendCache ||
		(new NodeCache<number>({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		}) as CacheStore)

	if (!config.placeholderResendCache) {
		config.placeholderResendCache = placeholderResendCache
	}

	/** helper function to fetch the given app state sync key */
	const getAppStateSyncKey = async (keyId: string) => {
		const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
		return key
	}

	const fetchPrivacySettings = async (force = false) => {
		if (!privacySettings || force) {
			const { content } = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'privacy',
					to: S_WHATSAPP_NET,
					type: 'get'
				},
				content: [{ tag: 'privacy', attrs: {} }]
			})
			privacySettings = reduceBinaryNodeToDictionary(content?.[0] as BinaryNode, 'category')
		}

		return privacySettings
	}

	/** helper function to run a privacy IQ query */
	const privacyQuery = async (name: string, value: string) => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'privacy',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'privacy',
					attrs: {},
					content: [
						{
							tag: 'category',
							attrs: { name, value }
						}
					]
				}
			]
		})
	}

	const updateMessagesPrivacy = async (value: WAPrivacyMessagesValue) => {
		await privacyQuery('messages', value)
	}

	const updateCallPrivacy = async (value: WAPrivacyCallValue) => {
		await privacyQuery('calladd', value)
	}

	const updateLastSeenPrivacy = async (value: WAPrivacyValue) => {
		await privacyQuery('last', value)
	}

	const updateOnlinePrivacy = async (value: WAPrivacyOnlineValue) => {
		await privacyQuery('online', value)
	}

	const updateProfilePicturePrivacy = async (value: WAPrivacyValue) => {
		await privacyQuery('profile', value)
	}

	const updateStatusPrivacy = async (value: WAPrivacyValue) => {
		await privacyQuery('status', value)
	}

	const updateReadReceiptsPrivacy = async (value: WAReadReceiptsValue) => {
		await privacyQuery('readreceipts', value)
	}

	const updateGroupsAddPrivacy = async (value: WAPrivacyGroupAddValue) => {
		await privacyQuery('groupadd', value)
	}

	const updateDefaultDisappearingMode = async (duration: number) => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'disappearing_mode',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'disappearing_mode',
					attrs: {
						duration: duration.toString()
					}
				}
			]
		})
	}

	const getBotListV2 = async () => {
		const resp = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'bot',
				to: S_WHATSAPP_NET,
				type: 'get'
			},
			content: [
				{
					tag: 'bot',
					attrs: {
						v: '2'
					}
				}
			]
		})

		const botNode = getBinaryNodeChild(resp, 'bot')

		const botList: BotListInfo[] = []
		for (const section of getBinaryNodeChildren(botNode, 'section')) {
			if (section.attrs.type === 'all') {
				for (const bot of getBinaryNodeChildren(section, 'bot')) {
					botList.push({
						jid: bot.attrs.jid!,
						personaId: bot.attrs['persona_id']!
					})
				}
			}
		}

		return botList
	}

	const fetchStatus = async (...jids: string[]) => {
		const usyncQuery = new USyncQuery().withStatusProtocol()

		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}

		const result = await sock.executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}

	const fetchDisappearingDuration = async (...jids: string[]) => {
		const usyncQuery = new USyncQuery().withDisappearingModeProtocol()

		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}

		const result = await sock.executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}

	/** update the profile picture for yourself or a group */
	const updateProfilePicture = async (
		jid: string,
		content: WAMediaUpload,
		dimensions?: { width: number; height: number }
	) => {
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me!.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		const { img } = await generateProfilePicture(content, dimensions)
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			},
			content: [
				{
					tag: 'picture',
					attrs: { type: 'image' },
					content: img
				}
			]
		})
	}

	/** remove the profile picture for yourself or a group */
	const removeProfilePicture = async (jid: string) => {
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me!.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			}
		})
	}

	/** update the profile status for yourself */
	const updateProfileStatus = async (status: string) => {
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'status'
			},
			content: [
				{
					tag: 'status',
					attrs: {},
					content: Buffer.from(status, 'utf-8')
				}
			]
		})
	}

	const updateProfileName = async (name: string) => {
		await chatModify({ pushNameSetting: name }, '')
	}

	const fetchBlocklist = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'get'
			}
		})

		const listNode = getBinaryNodeChild(result, 'list')
		return getBinaryNodeChildren(listNode, 'item').map(n => n.attrs.jid)
	}

	const updateBlockStatus = async (jid: string, action: 'block' | 'unblock') => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'item',
					attrs: {
						action,
						jid
					}
				}
			]
		})
	}

	const getBusinessProfile = async (jid: string): Promise<WABusinessProfile | void> => {
		const results = await query({
			tag: 'iq',
			attrs: {
				to: 's.whatsapp.net',
				xmlns: 'w:biz',
				type: 'get'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: { v: '244' },
					content: [
						{
							tag: 'profile',
							attrs: { jid }
						}
					]
				}
			]
		})

		const profileNode = getBinaryNodeChild(results, 'business_profile')
		const profiles = getBinaryNodeChild(profileNode, 'profile')
		if (profiles) {
			const address = getBinaryNodeChild(profiles, 'address')
			const description = getBinaryNodeChild(profiles, 'description')
			const website = getBinaryNodeChild(profiles, 'website')
			const email = getBinaryNodeChild(profiles, 'email')
			const category = getBinaryNodeChild(getBinaryNodeChild(profiles, 'categories'), 'category')
			const businessHours = getBinaryNodeChild(profiles, 'business_hours')
			const businessHoursConfig = businessHours
				? getBinaryNodeChildren(businessHours, 'business_hours_config')
				: undefined
			const websiteStr = website?.content?.toString()
			return {
				wid: profiles.attrs?.jid,
				address: address?.content?.toString(),
				description: description?.content?.toString() || '',
				website: websiteStr ? [websiteStr] : [],
				email: email?.content?.toString(),
				category: category?.content?.toString(),
				business_hours: {
					timezone: businessHours?.attrs?.timezone,
					business_config: businessHoursConfig?.map(({ attrs }) => attrs as unknown as WABusinessHoursConfig)
				}
			}
		}
	}

	const cleanDirtyBits = async (type: 'account_sync' | 'groups', fromTimestamp?: number | string) => {
		logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'urn:xmpp:whatsapp:dirty',
				id: generateMessageTag()
			},
			content: [
				{
					tag: 'clean',
					attrs: {
						type,
						...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null)
					}
				}
			]
		})
	}

	const newAppStateChunkHandler = (isInitialSync: boolean) => {
		return {
			onMutation(mutation: ChatMutation) {
				processSyncAction(
					mutation,
					ev,
					authState.creds.me!,
					isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined,
					logger
				)
			}
		}
	}

	const resyncAppState = ev.createBufferedFunction(
		async (collections: readonly WAPatchName[], isInitialSync: boolean) => {
			// we use this to determine which events to fire
			// otherwise when we resync from scratch -- all notifications will fire
			const initialVersionMap: { [T in WAPatchName]?: number } = {}
			const globalMutationMap: ChatMutationMap = {}

			await authState.keys.transaction(async () => {
				const collectionsToHandle = new Set<string>(collections)
				// in case something goes wrong -- ensure we don't enter a loop that cannot be exited from
				const attemptsMap: { [T in WAPatchName]?: number } = {}
				// keep executing till all collections are done
				// sometimes a single patch request will not return all the patches (God knows why)
				// so we fetch till they're all done (this is determined by the "has_more_patches" flag)
				while (collectionsToHandle.size) {
					const states = {} as { [T in WAPatchName]: LTHashState }
					const nodes: BinaryNode[] = []

					for (const name of collectionsToHandle as Set<WAPatchName>) {
						const result = await authState.keys.get('app-state-sync-version', [name])
						let state = result[name]

						if (state) {
							if (typeof initialVersionMap[name] === 'undefined') {
								initialVersionMap[name] = state.version
							}
						} else {
							state = newLTHashState()
						}

						states[name] = state

						logger.info(`resyncing ${name} from v${state.version}`)

						nodes.push({
							tag: 'collection',
							attrs: {
								name,
								version: state.version.toString(),
								// return snapshot if being synced from scratch
								return_snapshot: (!state.version).toString()
							}
						})
					}

					const result = await query({
						tag: 'iq',
						attrs: {
							to: S_WHATSAPP_NET,
							xmlns: 'w:sync:app:state',
							type: 'set'
						},
						content: [
							{
								tag: 'sync',
								attrs: {},
								content: nodes
							}
						]
					})

					// extract from binary node
					const decoded = await extractSyncdPatches(result, config?.options)
					for (const key in decoded) {
						const name = key as WAPatchName
						const { patches, hasMorePatches, snapshot } = decoded[name]
						try {
							if (snapshot) {
								const { state: newState, mutationMap } = await decodeSyncdSnapshot(
									name,
									snapshot,
									getAppStateSyncKey,
									initialVersionMap[name],
									appStateMacVerification.snapshot
								)
								states[name] = newState
								Object.assign(globalMutationMap, mutationMap)

								logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
							}

							// only process if there are syncd patches
							if (patches.length) {
								const { state: newState, mutationMap } = await decodePatches(
									name,
									patches,
									states[name],
									getAppStateSyncKey,
									config.options,
									initialVersionMap[name],
									logger,
									appStateMacVerification.patch
								)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })

								logger.info(`synced ${name} to v${newState.version}`)
								initialVersionMap[name] = newState.version

								Object.assign(globalMutationMap, mutationMap)
							}

							if (hasMorePatches) {
								logger.info(`${name} has more patches...`)
							} else {
								// collection is done with sync
								collectionsToHandle.delete(name)
							}
						} catch (error: any) {
							// if retry attempts overshoot
							// or key not found
							const isIrrecoverableError =
								attemptsMap[name]! >= MAX_SYNC_ATTEMPTS ||
								error.output?.statusCode === 404 ||
								error.name === 'TypeError'
							logger.info(
								{ name, error: error.stack },
								`failed to sync state from version${isIrrecoverableError ? '' : ', removing and trying from scratch'}`
							)
							await authState.keys.set({ 'app-state-sync-version': { [name]: null } })
							// increment number of retries
							attemptsMap[name] = (attemptsMap[name] || 0) + 1

							if (isIrrecoverableError) {
								// stop retrying
								collectionsToHandle.delete(name)
							}
						}
					}
				}
			}, authState?.creds?.me?.id || 'resync-app-state')

			const { onMutation } = newAppStateChunkHandler(isInitialSync)
			for (const key in globalMutationMap) {
				onMutation(globalMutationMap[key]!)
			}
		}
	)

	/**
	 * fetch the profile picture of a user/group
	 * type = "preview" for a low res picture
	 * type = "image for the high res picture"
	 */
	const profilePictureUrl = async (jid: string, type: 'preview' | 'image' = 'preview', timeoutMs?: number) => {
		// TOOD: Add support for tctoken, existingID, and newsletter + group options
		jid = jidNormalizedUser(jid)
		const result = await query(
			{
				tag: 'iq',
				attrs: {
					target: jid,
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'w:profile:picture'
				},
				content: [{ tag: 'picture', attrs: { type, query: 'url' } }]
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'picture')
		return child?.attrs?.url
	}

	const createCallLink = async (type: 'audio' | 'video', event?: { startTime: number }, timeoutMs?: number) => {
		const result = await query(
			{
				tag: 'call',
				attrs: {
					id: generateMessageTag(),
					to: '@call'
				},
				content: [
					{
						tag: 'link_create',
						attrs: { media: type },
						content: event ? [{ tag: 'event', attrs: { start_time: String(event.startTime) } }] : undefined
					}
				]
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'link_create')
		return child?.attrs?.token
	}

	const sendPresenceUpdate = async (type: WAPresence, toJid?: string) => {
		const me = authState.creds.me!
		if (type === 'available' || type === 'unavailable') {
			if (!me.name) {
				logger.warn('no name present, ignoring presence update request...')
				return
			}

			ev.emit('connection.update', { isOnline: type === 'available' })

			await sendNode({
				tag: 'presence',
				attrs: {
					name: me.name.replace(/@/g, ''),
					type
				}
			})
		} else {
			const { server } = jidDecode(toJid)!
			const isLid = server === 'lid'

			await sendNode({
				tag: 'chatstate',
				attrs: {
					from: isLid ? me.lid! : me.id,
					to: toJid!
				},
				content: [
					{
						tag: type === 'recording' ? 'composing' : type,
						attrs: type === 'recording' ? { media: 'audio' } : {}
					}
				]
			})
		}
	}

	/**
	 * @param toJid the jid to subscribe to
	 * @param tcToken token for subscription, use if present
	 */
	const presenceSubscribe = (toJid: string, tcToken?: Buffer) =>
		sendNode({
			tag: 'presence',
			attrs: {
				to: toJid,
				id: generateMessageTag(),
				type: 'subscribe'
			},
			content: tcToken
				? [
						{
							tag: 'tctoken',
							attrs: {},
							content: tcToken
						}
					]
				: undefined
		})

	const handlePresenceUpdate = ({ tag, attrs, content }: BinaryNode) => {
		let presence: PresenceData | undefined
		const jid = attrs.from
		const participant = attrs.participant || attrs.from

		if (shouldIgnoreJid(jid!) && jid !== '@s.whatsapp.net') {
			return
		}

		if (tag === 'presence') {
			presence = {
				lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
				lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined
			}
		} else if (Array.isArray(content)) {
			const [firstChild] = content
			let type = firstChild!.tag as WAPresence
			if (type === 'paused') {
				type = 'available'
			}

			if (firstChild!.attrs?.media === 'audio') {
				type = 'recording'
			}

			presence = { lastKnownPresence: type }
		} else {
			logger.error({ tag, attrs, content }, 'recv invalid presence node')
		}

		if (presence) {
			ev.emit('presence.update', { id: jid!, presences: { [participant!]: presence } })
		}
	}

	const appPatch = async (patchCreate: WAPatchCreate) => {
		const name = patchCreate.type
		const myAppStateKeyId = authState.creds.myAppStateKeyId
		if (!myAppStateKeyId) {
			throw new Boom('App state key not present!', { statusCode: 400 })
		}

		let initial: LTHashState
		let encodeResult: { patch: proto.ISyncdPatch; state: LTHashState }

		await processingMutex.mutex(async () => {
			await authState.keys.transaction(async () => {
				logger.debug({ patch: patchCreate }, 'applying app patch')

				await resyncAppState([name], false)

				const { [name]: currentSyncVersion } = await authState.keys.get('app-state-sync-version', [name])
				initial = currentSyncVersion || newLTHashState()

				encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey)
				const { patch, state } = encodeResult

				const node: BinaryNode = {
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						xmlns: 'w:sync:app:state'
					},
					content: [
						{
							tag: 'sync',
							attrs: {},
							content: [
								{
									tag: 'collection',
									attrs: {
										name,
										version: (state.version - 1).toString(),
										return_snapshot: 'false'
									},
									content: [
										{
											tag: 'patch',
											attrs: {},
											content: proto.SyncdPatch.encode(patch).finish()
										}
									]
								}
							]
						}
					]
				}
				await query(node)

				await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
			}, authState?.creds?.me?.id || 'app-patch')
		})

		if (config.emitOwnEvents) {
			const { onMutation } = newAppStateChunkHandler(false)
			const { mutationMap } = await decodePatches(
				name,
				[{ ...encodeResult!.patch, version: { version: encodeResult!.state.version } }],
				initial!,
				getAppStateSyncKey,
				config.options,
				undefined,
				logger
			)
			for (const key in mutationMap) {
				onMutation(mutationMap[key]!)
			}
		}
	}

	/** sending non-abt props may fix QR scan fail if server expects */
	const fetchProps = async () => {
		//TODO: implement both protocol 1 and protocol 2 prop fetching, specially for abKey for WM
		const resultNode = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'w',
				type: 'get'
			},
			content: [
				{
					tag: 'props',
					attrs: {
						protocol: '2',
						hash: authState?.creds?.lastPropHash || ''
					}
				}
			]
		})

		const propsNode = getBinaryNodeChild(resultNode, 'props')

		let props: { [_: string]: string } = {}
		if (propsNode) {
			if (propsNode.attrs?.hash) {
				// on some clients, the hash is returning as undefined
				authState.creds.lastPropHash = propsNode?.attrs?.hash
				ev.emit('creds.update', authState.creds)
			}

			props = reduceBinaryNodeToDictionary(propsNode, 'prop')
		}

		logger.debug('fetched props')

		return props
	}

	/**
	 * modify a chat -- mark unread, read etc.
	 * lastMessages must be sorted in reverse chronologically
	 * requires the last messages till the last message received; required for archive & unread
	 */
	const chatModify = (mod: ChatModification, jid: string) => {
		const patch = chatModificationToAppPatch(mod, jid)
		return appPatch(patch)
	}

	/**
	 * Enable/Disable link preview privacy, not related to baileys link preview generation
	 */
	const updateDisableLinkPreviewsPrivacy = (isPreviewsDisabled: boolean) => {
		return chatModify(
			{
				disableLinkPreviews: { isPreviewsDisabled }
			},
			''
		)
	}

	/**
	 * Star or Unstar a message
	 */
	const star = (jid: string, messages: { id: string; fromMe?: boolean }[], star: boolean) => {
		return chatModify(
			{
				star: {
					messages,
					star
				}
			},
			jid
		)
	}

	/**
	 * Add or Edit Contact
	 */
	const addOrEditContact = (jid: string, contact: proto.SyncActionValue.IContactAction) => {
		return chatModify(
			{
				contact
			},
			jid
		)
	}

	/**
	 * Remove Contact
	 */
	const removeContact = (jid: string) => {
		return chatModify(
			{
				contact: null
			},
			jid
		)
	}

	/**
	 * Adds label
	 */
	const addLabel = (jid: string, labels: LabelActionBody) => {
		return chatModify(
			{
				addLabel: {
					...labels
				}
			},
			jid
		)
	}

	/**
	 * Adds label for the chats
	 */
	const addChatLabel = (jid: string, labelId: string) => {
		return chatModify(
			{
				addChatLabel: {
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Removes label for the chat
	 */
	const removeChatLabel = (jid: string, labelId: string) => {
		return chatModify(
			{
				removeChatLabel: {
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Adds label for the message
	 */
	const addMessageLabel = (jid: string, messageId: string, labelId: string) => {
		return chatModify(
			{
				addMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Removes label for the message
	 */
	const removeMessageLabel = (jid: string, messageId: string, labelId: string) => {
		return chatModify(
			{
				removeMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}

	/**
	 * Add or Edit Quick Reply
	 */
	const addOrEditQuickReply = (quickReply: QuickReplyAction) => {
		return chatModify(
			{
				quickReply
			},
			''
		)
	}

	/**
	 * Remove Quick Reply
	 */
	const removeQuickReply = (timestamp: string) => {
		return chatModify(
			{
				quickReply: { timestamp, deleted: true }
			},
			''
		)
	}

	/**
	 * queries need to be fired on connection open
	 * help ensure parity with WA Web
	 * */
	const executeInitQueries = async () => {
		await Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()])
	}

	const upsertMessage = ev.createBufferedFunction(async (msg: WAMessage, type: MessageUpsertType) => {
		ev.emit('messages.upsert', { messages: [msg], type })

		if (!!msg.pushName) {
			let jid = msg.key.fromMe ? authState.creds.me!.id : msg.key.participant || msg.key.remoteJid
			jid = jidNormalizedUser(jid!)

			if (!msg.key.fromMe) {
				ev.emit('contacts.update', [{ id: jid, notify: msg.pushName, verifiedName: msg.verifiedBizName! }])
			}

			// update our pushname too
			if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) {
				ev.emit('creds.update', { me: { ...authState.creds.me!, name: msg.pushName } })
			}
		}

		const historyMsg = getHistoryMsg(msg.message!)
		const shouldProcessHistoryMsg = historyMsg
			? shouldSyncHistoryMessage(historyMsg) && PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType!)
			: false

		// State machine: decide on sync and flush
		if (historyMsg && syncState === SyncState.AwaitingInitialSync) {
			if (awaitingSyncTimeout) {
				clearTimeout(awaitingSyncTimeout)
				awaitingSyncTimeout = undefined
			}

			if (shouldProcessHistoryMsg) {
				syncState = SyncState.Syncing
				logger.info('Transitioned to Syncing state')
				// Let doAppStateSync handle the final flush after it's done
			} else {
				syncState = SyncState.Online
				logger.info('History sync skipped, transitioning to Online state and flushing buffer')
				ev.flush()
			}
		}

		const doAppStateSync = async () => {
			if (syncState === SyncState.Syncing) {
				logger.info('Doing app state sync')
				await resyncAppState(ALL_WA_PATCH_NAMES, true)

				// Sync is complete, go online and flush everything
				syncState = SyncState.Online
				logger.info('App state sync complete, transitioning to Online state and flushing buffer')
				ev.flush()

				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
			}
		}

		await Promise.all([
			(async () => {
				if (shouldProcessHistoryMsg) {
					await doAppStateSync()
				}
			})(),
			processMessage(msg, {
				signalRepository,
				shouldProcessHistoryMsg,
				placeholderResendCache,
				ev,
				creds: authState.creds,
				keyStore: authState.keys,
				logger,
				options: config.options
			})
		])

		// If the app state key arrives and we are waiting to sync, trigger the sync now.
		if (msg.message?.protocolMessage?.appStateSyncKeyShare && syncState === SyncState.Syncing) {
			logger.info('App state sync key arrived, triggering app state sync')
			await doAppStateSync()
		}
	})

	ws.on('CB:presence', handlePresenceUpdate)
	ws.on('CB:chatstate', handlePresenceUpdate)

	ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		const type = attrs.type
		switch (type) {
			case 'account_sync':
				if (attrs.timestamp) {
					let { lastAccountSyncTimestamp } = authState.creds
					if (lastAccountSyncTimestamp) {
						await cleanDirtyBits('account_sync', lastAccountSyncTimestamp)
					}

					lastAccountSyncTimestamp = +attrs.timestamp
					ev.emit('creds.update', { lastAccountSyncTimestamp })
				}

				break
			case 'groups':
				// handled in groups.ts
				break
			default:
				logger.info({ node }, 'received unknown sync')
				break
		}
	})

	ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
		if (connection === 'open') {
			if (fireInitQueries) {
				executeInitQueries().catch(error => onUnexpectedError(error, 'init queries'))
			}

			sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable').catch(error =>
				onUnexpectedError(error, 'presence update requests')
			)
		}

		if (!receivedPendingNotifications || syncState !== SyncState.Connecting) {
			return
		}

		syncState = SyncState.AwaitingInitialSync
		logger.info('Connection is now AwaitingInitialSync, buffering events')
		ev.buffer()

		const willSyncHistory = shouldSyncHistoryMessage(
			proto.Message.HistorySyncNotification.create({
				syncType: proto.HistorySync.HistorySyncType.RECENT
			})
		)

		if (!willSyncHistory) {
			logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.')
			syncState = SyncState.Online
			setTimeout(() => ev.flush(), 0)
			return
		}

		logger.info('History sync is enabled, awaiting notification with a 20s timeout.')

		if (awaitingSyncTimeout) {
			clearTimeout(awaitingSyncTimeout)
		}

		awaitingSyncTimeout = setTimeout(() => {
			if (syncState === SyncState.AwaitingInitialSync) {
				logger.warn('Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer')
				syncState = SyncState.Online
				ev.flush()
			}
		}, 20_000)
	})

	return {
		...sock,
		createCallLink,
		getBotListV2,
		processingMutex,
		fetchPrivacySettings,
		upsertMessage,
		appPatch,
		sendPresenceUpdate,
		presenceSubscribe,
		profilePictureUrl,
		fetchBlocklist,
		fetchStatus,
		fetchDisappearingDuration,
		updateProfilePicture,
		removeProfilePicture,
		updateProfileStatus,
		updateProfileName,
		updateBlockStatus,
		updateDisableLinkPreviewsPrivacy,
		updateCallPrivacy,
		updateMessagesPrivacy,
		updateLastSeenPrivacy,
		updateOnlinePrivacy,
		updateProfilePicturePrivacy,
		updateStatusPrivacy,
		updateReadReceiptsPrivacy,
		updateGroupsAddPrivacy,
		updateDefaultDisappearingMode,
		getBusinessProfile,
		resyncAppState,
		chatModify,
		cleanDirtyBits,
		addOrEditContact,
		removeContact,
		addLabel,
		addChatLabel,
		removeChatLabel,
		addMessageLabel,
		removeMessageLabel,
		star,
		addOrEditQuickReply,
		removeQuickReply
	}
}



================================================
FILE: src/Socket/communities.ts
================================================
import { proto } from '../../WAProto/index.js'
import {
	type GroupMetadata,
	type GroupParticipant,
	type ParticipantAction,
	type SocketConfig,
	type WAMessageKey,
	WAMessageStubType
} from '../Types'
import { generateMessageID, generateMessageIDV2, unixTimestampSeconds } from '../Utils'
import logger from '../Utils/logger'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { makeBusinessSocket } from './business'

export const makeCommunitiesSocket = (config: SocketConfig) => {
	const sock = makeBusinessSocket(config)
	const { authState, ev, query, upsertMessage } = sock

	const communityQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]) =>
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid
			},
			content
		})

	const communityMetadata = async (jid: string) => {
		const result = await communityQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
		return extractCommunityMetadata(result)
	}

	const communityFetchAllParticipating = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: '@g.us',
				xmlns: 'w:g2',
				type: 'get'
			},
			content: [
				{
					tag: 'participating',
					attrs: {},
					content: [
						{ tag: 'participants', attrs: {} },
						{ tag: 'description', attrs: {} }
					]
				}
			]
		})
		const data: { [_: string]: GroupMetadata } = {}
		const communitiesChild = getBinaryNodeChild(result, 'communities')
		if (communitiesChild) {
			const communities = getBinaryNodeChildren(communitiesChild, 'community')
			for (const communityNode of communities) {
				const meta = extractCommunityMetadata({
					tag: 'result',
					attrs: {},
					content: [communityNode]
				})
				data[meta.id] = meta
			}
		}

		sock.ev.emit('groups.update', Object.values(data))

		return data
	}

	async function parseGroupResult(node: BinaryNode) {
		logger.info({ node }, 'parseGroupResult')
		const groupNode = getBinaryNodeChild(node, 'group')
		if (groupNode) {
			try {
				logger.info({ groupNode }, 'groupNode')
				const metadata = await sock.groupMetadata(`${groupNode.attrs.id}@g.us`)
				return metadata ? metadata : Optional.empty()
			} catch (error) {
				console.error('Error parsing group metadata:', error)
				return Optional.empty()
			}
		}

		return Optional.empty()
	}

	const Optional = {
		empty: () => null,
		of: (value: null) => (value !== null ? { value } : null)
	}

	sock.ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		if (attrs.type !== 'communities') {
			return
		}

		await communityFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})

	return {
		...sock,
		communityMetadata,
		communityCreate: async (subject: string, body: string) => {
			const descriptionId = generateMessageID().substring(0, 12)

			const result = await communityQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: { subject },
					content: [
						{
							tag: 'description',
							attrs: { id: descriptionId },
							content: [
								{
									tag: 'body',
									attrs: {},
									content: Buffer.from(body || '', 'utf-8')
								}
							]
						},
						{
							tag: 'parent',
							attrs: { default_membership_approval_mode: 'request_required' }
						},
						{
							tag: 'allow_non_admin_sub_group_creation',
							attrs: {}
						},
						{
							tag: 'create_general_chat',
							attrs: {}
						}
					]
				}
			])

			return await parseGroupResult(result)
		},
		communityCreateGroup: async (subject: string, participants: string[], parentCommunityJid: string) => {
			const key = generateMessageIDV2()
			const result = await communityQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
						key
					},
					content: [
						...participants.map(jid => ({
							tag: 'participant',
							attrs: { jid }
						})),
						{ tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
					]
				}
			])
			return await parseGroupResult(result)
		},
		communityLeave: async (id: string) => {
			await communityQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'community', attrs: { id } }]
				}
			])
		},
		communityUpdateSubject: async (jid: string, subject: string) => {
			await communityQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8')
				}
			])
		},
		communityLinkGroup: async (groupJid: string, parentCommunityJid: string) => {
			await communityQuery(parentCommunityJid, 'set', [
				{
					tag: 'links',
					attrs: {},
					content: [
						{
							tag: 'link',
							attrs: { link_type: 'sub_group' },
							content: [{ tag: 'group', attrs: { jid: groupJid } }]
						}
					]
				}
			])
		},
		communityUnlinkGroup: async (groupJid: string, parentCommunityJid: string) => {
			await communityQuery(parentCommunityJid, 'set', [
				{
					tag: 'unlink',
					attrs: { unlink_type: 'sub_group' },
					content: [{ tag: 'group', attrs: { jid: groupJid } }]
				}
			])
		},
		communityFetchLinkedGroups: async (jid: string) => {
			let communityJid = jid
			let isCommunity = false

			// Try to determine if it is a subgroup or a community
			const metadata = await sock.groupMetadata(jid)
			if (metadata.linkedParent) {
				// It is a subgroup, get the community jid
				communityJid = metadata.linkedParent
			} else {
				// It is a community
				isCommunity = true
			}

			// Fetch all subgroups of the community
			const result = await communityQuery(communityJid, 'get', [{ tag: 'sub_groups', attrs: {} }])

			const linkedGroupsData = []
			const subGroupsNode = getBinaryNodeChild(result, 'sub_groups')
			if (subGroupsNode) {
				const groupNodes = getBinaryNodeChildren(subGroupsNode, 'group')
				for (const groupNode of groupNodes) {
					linkedGroupsData.push({
						id: groupNode.attrs.id ? jidEncode(groupNode.attrs.id, 'g.us') : undefined,
						subject: groupNode.attrs.subject || '',
						creation: groupNode.attrs.creation ? Number(groupNode.attrs.creation) : undefined,
						owner: groupNode.attrs.creator ? jidNormalizedUser(groupNode.attrs.creator) : undefined,
						size: groupNode.attrs.size ? Number(groupNode.attrs.size) : undefined
					})
				}
			}

			return {
				communityJid,
				isCommunity,
				linkedGroups: linkedGroupsData
			}
		},
		communityRequestParticipantsList: async (jid: string) => {
			const result = await communityQuery(jid, 'get', [
				{
					tag: 'membership_approval_requests',
					attrs: {}
				}
			])
			const node = getBinaryNodeChild(result, 'membership_approval_requests')
			const participants = getBinaryNodeChildren(node, 'membership_approval_request')
			return participants.map(v => v.attrs)
		},
		communityRequestParticipantsUpdate: async (jid: string, participants: string[], action: 'approve' | 'reject') => {
			const result = await communityQuery(jid, 'set', [
				{
					tag: 'membership_requests_action',
					attrs: {},
					content: [
						{
							tag: action,
							attrs: {},
							content: participants.map(jid => ({
								tag: 'participant',
								attrs: { jid }
							}))
						}
					]
				}
			])
			const node = getBinaryNodeChild(result, 'membership_requests_action')
			const nodeAction = getBinaryNodeChild(node, action)
			const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid }
			})
		},
		communityParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			const result = await communityQuery(jid, 'set', [
				{
					tag: action,
					attrs: {},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			const node = getBinaryNodeChild(result, action)
			const participantsAffected = getBinaryNodeChildren(node, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
			})
		},
		communityUpdateDescription: async (jid: string, description?: string) => {
			const metadata = await communityMetadata(jid)
			const prev = metadata.descId ?? null

			await communityQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: {
						...(description ? { id: generateMessageID() } : { delete: 'true' }),
						...(prev ? { prev } : {})
					},
					content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
				}
			])
		},
		communityInviteCode: async (jid: string) => {
			const result = await communityQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		communityRevokeInvite: async (jid: string) => {
			const result = await communityQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		communityAcceptInvite: async (code: string) => {
			const results = await communityQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = getBinaryNodeChild(results, 'community')
			return result?.attrs.jid
		},

		/**
		 * revoke a v4 invite for someone
		 * @param communityJid community jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		communityRevokeInviteV4: async (communityJid: string, invitedJid: string) => {
			const result = await communityQuery(communityJid, 'set', [
				{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
			])
			return !!result
		},

		/**
		 * accept a CommunityInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		communityAcceptInviteV4: ev.createBufferedFunction(
			async (key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => {
				key = typeof key === 'string' ? { remoteJid: key } : key
				const results = await communityQuery(inviteMessage.groupJid!, 'set', [
					{
						tag: 'accept',
						attrs: {
							code: inviteMessage.inviteCode!,
							expiration: inviteMessage.inviteExpiration!.toString(),
							admin: key.remoteJid!
						}
					}
				])

				// if we have the full message key
				// update the invite message to be expired
				if (key.id) {
					// create new invite message that is expired
					inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
					inviteMessage.inviteExpiration = 0
					inviteMessage.inviteCode = ''
					ev.emit('messages.update', [
						{
							key,
							update: {
								message: {
									groupInviteMessage: inviteMessage
								}
							}
						}
					])
				}

				// generate the community add message
				await upsertMessage(
					{
						key: {
							remoteJid: inviteMessage.groupJid,
							id: generateMessageIDV2(sock.user?.id),
							fromMe: false,
							participant: key.remoteJid // TODO: investigate if this makes any sense at all
						},
						messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
						messageStubParameters: [JSON.stringify(authState.creds.me)],
						participant: key.remoteJid,
						messageTimestamp: unixTimestampSeconds()
					},
					'notify'
				)

				return results.attrs.from
			}
		),
		communityGetInviteInfo: async (code: string) => {
			const results = await communityQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
			return extractCommunityMetadata(results)
		},
		communityToggleEphemeral: async (jid: string, ephemeralExpiration: number) => {
			const content: BinaryNode = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await communityQuery(jid, 'set', [content])
		},
		communitySettingUpdate: async (
			jid: string,
			setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'
		) => {
			await communityQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		communityMemberAddMode: async (jid: string, mode: 'admin_add' | 'all_member_add') => {
			await communityQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
		},
		communityJoinApprovalMode: async (jid: string, mode: 'on' | 'off') => {
			await communityQuery(jid, 'set', [
				{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'community_join', attrs: { state: mode } }] }
			])
		},
		communityFetchAllParticipating
	}
}

export const extractCommunityMetadata = (result: BinaryNode) => {
	const community = getBinaryNodeChild(result, 'community')!
	const descChild = getBinaryNodeChild(community, 'description')
	let desc: string | undefined
	let descId: string | undefined
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descId = descChild.attrs.id
	}

	const communityId = community.attrs.id?.includes('@')
		? community.attrs.id
		: jidEncode(community.attrs.id || '', 'g.us')
	const eph = getBinaryNodeChild(community, 'ephemeral')?.attrs.expiration
	const memberAddMode = getBinaryNodeChildString(community, 'member_add_mode') === 'all_member_add'
	const metadata: GroupMetadata = {
		id: communityId,
		subject: community.attrs.subject || '',
		subjectOwner: community.attrs.s_o,
		subjectTime: Number(community.attrs.s_t || 0),
		size: getBinaryNodeChildren(community, 'participant').length,
		creation: Number(community.attrs.creation || 0),
		owner: community.attrs.creator ? jidNormalizedUser(community.attrs.creator) : undefined,
		desc,
		descId,
		linkedParent: getBinaryNodeChild(community, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(community, 'locked'),
		announce: !!getBinaryNodeChild(community, 'announcement'),
		isCommunity: !!getBinaryNodeChild(community, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(community, 'default_sub_community'),
		joinApprovalMode: !!getBinaryNodeChild(community, 'membership_approval_mode'),
		memberAddMode,
		participants: getBinaryNodeChildren(community, 'participant').map(({ attrs }) => {
			return {
				// TODO: IMPLEMENT THE PN/LID FIELDS HERE!!
				id: attrs.jid!,
				admin: (attrs.type || null) as GroupParticipant['admin']
			}
		}),
		ephemeralDuration: eph ? +eph : undefined,
		addressingMode: getBinaryNodeChildString(community, 'addressing_mode')! as GroupMetadata['addressingMode']
	}
	return metadata
}



================================================
FILE: src/Socket/groups.ts
================================================
import { proto } from '../../WAProto/index.js'
import type { GroupMetadata, GroupParticipant, ParticipantAction, SocketConfig, WAMessageKey } from '../Types'
import { WAMessageAddressingMode, WAMessageStubType } from '../Types'
import { generateMessageIDV2, unixTimestampSeconds } from '../Utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isLidUser,
	isPnUser,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { makeChatsSocket } from './chats'

export const makeGroupsSocket = (config: SocketConfig) => {
	const sock = makeChatsSocket(config)
	const { authState, ev, query, upsertMessage } = sock

	const groupQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]) =>
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid
			},
			content
		})

	const groupMetadata = async (jid: string) => {
		const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
		return extractGroupMetadata(result)
	}

	const groupFetchAllParticipating = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: '@g.us',
				xmlns: 'w:g2',
				type: 'get'
			},
			content: [
				{
					tag: 'participating',
					attrs: {},
					content: [
						{ tag: 'participants', attrs: {} },
						{ tag: 'description', attrs: {} }
					]
				}
			]
		})
		const data: { [_: string]: GroupMetadata } = {}
		const groupsChild = getBinaryNodeChild(result, 'groups')
		if (groupsChild) {
			const groups = getBinaryNodeChildren(groupsChild, 'group')
			for (const groupNode of groups) {
				const meta = extractGroupMetadata({
					tag: 'result',
					attrs: {},
					content: [groupNode]
				})
				data[meta.id] = meta
			}
		}

		// TODO: properly parse LID / PN DATA
		sock.ev.emit('groups.update', Object.values(data))

		return data
	}

	sock.ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		if (attrs.type !== 'groups') {
			return
		}

		await groupFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})

	return {
		...sock,
		groupMetadata,
		groupCreate: async (subject: string, participants: string[]) => {
			const key = generateMessageIDV2()
			const result = await groupQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
						key
					},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			return extractGroupMetadata(result)
		},
		groupLeave: async (id: string) => {
			await groupQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'group', attrs: { id } }]
				}
			])
		},
		groupUpdateSubject: async (jid: string, subject: string) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8')
				}
			])
		},
		groupRequestParticipantsList: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [
				{
					tag: 'membership_approval_requests',
					attrs: {}
				}
			])
			const node = getBinaryNodeChild(result, 'membership_approval_requests')
			const participants = getBinaryNodeChildren(node, 'membership_approval_request')
			return participants.map(v => v.attrs)
		},
		groupRequestParticipantsUpdate: async (jid: string, participants: string[], action: 'approve' | 'reject') => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: 'membership_requests_action',
					attrs: {},
					content: [
						{
							tag: action,
							attrs: {},
							content: participants.map(jid => ({
								tag: 'participant',
								attrs: { jid }
							}))
						}
					]
				}
			])
			const node = getBinaryNodeChild(result, 'membership_requests_action')
			const nodeAction = getBinaryNodeChild(node, action)
			const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid }
			})
		},
		groupParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: action,
					attrs: {},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			const node = getBinaryNodeChild(result, action)
			const participantsAffected = getBinaryNodeChildren(node, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
			})
		},
		groupUpdateDescription: async (jid: string, description?: string) => {
			const metadata = await groupMetadata(jid)
			const prev = metadata.descId ?? null

			await groupQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: {
						...(description ? { id: generateMessageIDV2() } : { delete: 'true' }),
						...(prev ? { prev } : {})
					},
					content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
				}
			])
		},
		groupInviteCode: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupRevokeInvite: async (jid: string) => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupAcceptInvite: async (code: string) => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = getBinaryNodeChild(results, 'group')
			return result?.attrs.jid
		},

		/**
		 * revoke a v4 invite for someone
		 * @param groupJid group jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		groupRevokeInviteV4: async (groupJid: string, invitedJid: string) => {
			const result = await groupQuery(groupJid, 'set', [
				{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
			])
			return !!result
		},

		/**
		 * accept a GroupInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		groupAcceptInviteV4: ev.createBufferedFunction(
			async (key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => {
				key = typeof key === 'string' ? { remoteJid: key } : key
				const results = await groupQuery(inviteMessage.groupJid!, 'set', [
					{
						tag: 'accept',
						attrs: {
							code: inviteMessage.inviteCode!,
							expiration: inviteMessage.inviteExpiration!.toString(),
							admin: key.remoteJid!
						}
					}
				])

				// if we have the full message key
				// update the invite message to be expired
				if (key.id) {
					// create new invite message that is expired
					inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
					inviteMessage.inviteExpiration = 0
					inviteMessage.inviteCode = ''
					ev.emit('messages.update', [
						{
							key,
							update: {
								message: {
									groupInviteMessage: inviteMessage
								}
							}
						}
					])
				}

				// generate the group add message
				await upsertMessage(
					{
						key: {
							remoteJid: inviteMessage.groupJid,
							id: generateMessageIDV2(sock.user?.id),
							fromMe: false,
							participant: key.remoteJid
						},
						messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
						messageStubParameters: [JSON.stringify(authState.creds.me)],
						participant: key.remoteJid,
						messageTimestamp: unixTimestampSeconds()
					},
					'notify'
				)

				return results.attrs.from
			}
		),
		groupGetInviteInfo: async (code: string) => {
			const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
			return extractGroupMetadata(results)
		},
		groupToggleEphemeral: async (jid: string, ephemeralExpiration: number) => {
			const content: BinaryNode = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await groupQuery(jid, 'set', [content])
		},
		groupSettingUpdate: async (jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') => {
			await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		groupMemberAddMode: async (jid: string, mode: 'admin_add' | 'all_member_add') => {
			await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
		},
		groupJoinApprovalMode: async (jid: string, mode: 'on' | 'off') => {
			await groupQuery(jid, 'set', [
				{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }
			])
		},
		groupFetchAllParticipating
	}
}

export const extractGroupMetadata = (result: BinaryNode) => {
	const group = getBinaryNodeChild(result, 'group')!
	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	let descOwner: string | undefined
	let descOwnerPn: string | undefined
	let descTime: number | undefined
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descOwner = descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined
		descOwnerPn = descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined
		descTime = +descChild.attrs.t!
		descId = descChild.attrs.id
	}

	const groupId = group.attrs.id!.includes('@') ? group.attrs.id : jidEncode(group.attrs.id!, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const memberAddMode = getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add'
	const metadata: GroupMetadata = {
		id: groupId!,
		notify: group.attrs.notify,
		addressingMode: group.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
		subject: group.attrs.subject!,
		subjectOwner: group.attrs.s_o,
		subjectOwnerPn: group.attrs.s_o_pn,
		subjectTime: +group.attrs.s_t!,
		size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
		creation: +group.attrs.creation!,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
		owner_country_code: group.attrs.creator_country_code,
		desc,
		descId,
		descOwner,
		descOwnerPn,
		descTime,
		linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		isCommunity: !!getBinaryNodeChild(group, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
		joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
		memberAddMode,
		participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => {
			// TODO: Store LID MAPPINGS
			return {
				id: attrs.jid!,
				phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
				lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
				admin: (attrs.type || null) as GroupParticipant['admin']
			}
		}),
		ephemeralDuration: eph ? +eph : undefined
	}
	return metadata
}

export type GroupsSocket = ReturnType<typeof makeGroupsSocket>



================================================
FILE: src/Socket/index.ts
================================================
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { makeCommunitiesSocket } from './communities'

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	// If the user hasn't provided their own history sync function,
	// let's create a default one that respects the syncFullHistory flag.
	// TODO: Change
	if (config.shouldSyncHistoryMessage === undefined) {
		newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory
	}

	return makeCommunitiesSocket(newConfig)
}

export default makeWASocket



================================================
FILE: src/Socket/messages-recv.ts
================================================
import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import Long from 'long'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, KEY_BUNDLE_TYPE, MIN_PREKEY_COUNT } from '../Defaults'
import type {
	GroupParticipant,
	MessageReceiptType,
	MessageRelayOptions,
	MessageUserReceipt,
	SocketConfig,
	WACallEvent,
	WACallUpdateType,
	WAMessage,
	WAMessageKey,
	WAPatchName
} from '../Types'
import { WAMessageStatus, WAMessageStubType } from '../Types'
import {
	aesDecryptCTR,
	aesEncryptGCM,
	cleanMessage,
	Curve,
	decodeMediaRetryNode,
	decodeMessageNode,
	decryptMessageNode,
	delay,
	derivePairingCodeKey,
	encodeBigEndian,
	encodeSignedDeviceIdentity,
	extractAddressingContext,
	getCallStatusFromNode,
	getHistoryMsg,
	getNextPreKeys,
	getStatusFromReceiptType,
	hkdf,
	MISSING_KEYS_ERROR_TEXT,
	NACK_REASONS,
	unixTimestampSeconds,
	xmppPreKey,
	xmppSignedPreKey
} from '../Utils'
import { makeMutex } from '../Utils/make-mutex'
import {
	areJidsSameUser,
	type BinaryNode,
	binaryNodeToString,
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isJidGroup,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	jidDecode,
	jidNormalizedUser,
	S_WHATSAPP_NET
} from '../WABinary'
import { extractGroupMetadata } from './groups'
import { makeMessagesSocket } from './messages-send'

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation } =
		config
	const sock = makeMessagesSocket(config)
	const {
		ev,
		authState,
		ws,
		processingMutex,
		signalRepository,
		query,
		upsertMessage,
		resyncAppState,
		onUnexpectedError,
		assertSessions,
		sendNode,
		relayMessage,
		sendReceipt,
		uploadPreKeys,
		sendPeerDataOperationMessage,
		messageRetryManager
	} = sock

	/** this mutex ensures that each retryRequest will wait for the previous one to finish */
	const retryMutex = makeMutex()

	const msgRetryCache =
		config.msgRetryCounterCache ||
		new NodeCache<number>({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		})
	const callOfferCache =
		config.callOfferCache ||
		new NodeCache<WACallEvent>({
			stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
			useClones: false
		})

	const placeholderResendCache =
		config.placeholderResendCache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		})

	let sendActiveReceipts = false

	const fetchMessageHistory = async (
		count: number,
		oldestMsgKey: WAMessageKey,
		oldestMsgTimestamp: number | Long
	): Promise<string> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const pdoMessage: proto.Message.IPeerDataOperationRequestMessage = {
			historySyncOnDemandRequest: {
				chatJid: oldestMsgKey.remoteJid,
				oldestMsgFromMe: oldestMsgKey.fromMe,
				oldestMsgId: oldestMsgKey.id,
				oldestMsgTimestampMs: oldestMsgTimestamp,
				onDemandMsgCount: count
			},
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
		}

		return sendPeerDataOperationMessage(pdoMessage)
	}

	const requestPlaceholderResend = async (messageKey: WAMessageKey): Promise<string | undefined> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		if (placeholderResendCache.get(messageKey?.id!)) {
			logger.debug({ messageKey }, 'already requested resend')
			return
		} else {
			placeholderResendCache.set(messageKey?.id!, true)
		}

		await delay(5000)

		if (!placeholderResendCache.get(messageKey?.id!)) {
			logger.debug({ messageKey }, 'message received while resend requested')
			return 'RESOLVED'
		}

		const pdoMessage = {
			placeholderMessageResendRequest: [
				{
					messageKey
				}
			],
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
		}

		setTimeout(() => {
			if (placeholderResendCache.get(messageKey?.id!)) {
				logger.debug({ messageKey }, 'PDO message without response after 15 seconds. Phone possibly offline')
				placeholderResendCache.del(messageKey?.id!)
			}
		}, 15_000)

		return sendPeerDataOperationMessage(pdoMessage)
	}

	// Handles mex newsletter notifications
	const handleMexNewsletterNotification = async (node: BinaryNode) => {
		const mexNode = getBinaryNodeChild(node, 'mex')
		if (!mexNode?.content) {
			logger.warn({ node }, 'Invalid mex newsletter notification')
			return
		}

		let data: any
		try {
			data = JSON.parse(mexNode.content.toString())
		} catch (error) {
			logger.error({ err: error, node }, 'Failed to parse mex newsletter notification')
			return
		}

		const operation = data?.operation
		const updates = data?.updates

		if (!updates || !operation) {
			logger.warn({ data }, 'Invalid mex newsletter notification content')
			return
		}

		logger.info({ operation, updates }, 'got mex newsletter notification')

		switch (operation) {
			case 'NotificationNewsletterUpdate':
				for (const update of updates) {
					if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
						ev.emit('newsletter-settings.update', {
							id: update.jid,
							update: update.settings
						})
					}
				}

				break

			case 'NotificationNewsletterAdminPromote':
				for (const update of updates) {
					if (update.jid && update.user) {
						ev.emit('newsletter-participants.update', {
							id: update.jid,
							author: node.attrs.from!,
							user: update.user,
							new_role: 'ADMIN',
							action: 'promote'
						})
					}
				}

				break

			default:
				logger.info({ operation, data }, 'Unhandled mex newsletter notification')
				break
		}
	}

	// Handles newsletter notifications
	const handleNewsletterNotification = async (node: BinaryNode) => {
		const from = node.attrs.from!
		const child = getAllBinaryNodeChildren(node)[0]!
		const author = node.attrs.participant!

		logger.info({ from, child }, 'got newsletter notification')

		switch (child.tag) {
			case 'reaction':
				const reactionUpdate = {
					id: from,
					server_id: child.attrs.message_id!,
					reaction: {
						code: getBinaryNodeChildString(child, 'reaction'),
						count: 1
					}
				}
				ev.emit('newsletter.reaction', reactionUpdate)
				break

			case 'view':
				const viewUpdate = {
					id: from,
					server_id: child.attrs.message_id!,
					count: parseInt(child.content?.toString() || '0', 10)
				}
				ev.emit('newsletter.view', viewUpdate)
				break

			case 'participant':
				const participantUpdate = {
					id: from,
					author,
					user: child.attrs.jid!,
					action: child.attrs.action!,
					new_role: child.attrs.role!
				}
				ev.emit('newsletter-participants.update', participantUpdate)
				break

			case 'update':
				const settingsNode = getBinaryNodeChild(child, 'settings')
				if (settingsNode) {
					const update: Record<string, any> = {}
					const nameNode = getBinaryNodeChild(settingsNode, 'name')
					if (nameNode?.content) update.name = nameNode.content.toString()

					const descriptionNode = getBinaryNodeChild(settingsNode, 'description')
					if (descriptionNode?.content) update.description = descriptionNode.content.toString()

					ev.emit('newsletter-settings.update', {
						id: from,
						update
					})
				}

				break

			case 'message':
				const plaintextNode = getBinaryNodeChild(child, 'plaintext')
				if (plaintextNode?.content) {
					try {
						const contentBuf =
							typeof plaintextNode.content === 'string'
								? Buffer.from(plaintextNode.content, 'binary')
								: Buffer.from(plaintextNode.content as Uint8Array)
						const messageProto = proto.Message.decode(contentBuf).toJSON()
						const fullMessage = proto.WebMessageInfo.fromObject({
							key: {
								remoteJid: from,
								id: child.attrs.message_id || child.attrs.server_id,
								fromMe: false // TODO: is this really true though
							},
							message: messageProto,
							messageTimestamp: +child.attrs.t!
						}).toJSON() as WAMessage
						await upsertMessage(fullMessage, 'append')
						logger.info('Processed plaintext newsletter message')
					} catch (error) {
						logger.error({ error }, 'Failed to decode plaintext newsletter message')
					}
				}

				break

			default:
				logger.warn({ node }, 'Unknown newsletter notification')
				break
		}
	}

	const sendMessageAck = async ({ tag, attrs, content }: BinaryNode, errorCode?: number) => {
		const stanza: BinaryNode = {
			tag: 'ack',
			attrs: {
				id: attrs.id!,
				to: attrs.from!,
				class: tag
			}
		}

		if (!!errorCode) {
			stanza.attrs.error = errorCode.toString()
		}

		if (!!attrs.participant) {
			stanza.attrs.participant = attrs.participant
		}

		if (!!attrs.recipient) {
			stanza.attrs.recipient = attrs.recipient
		}

		if (
			!!attrs.type &&
			(tag !== 'message' || getBinaryNodeChild({ tag, attrs, content }, 'unavailable') || errorCode !== 0)
		) {
			stanza.attrs.type = attrs.type
		}

		if (tag === 'message' && getBinaryNodeChild({ tag, attrs, content }, 'unavailable')) {
			stanza.attrs.from = authState.creds.me!.id
		}

		logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, 'sent ack')
		await sendNode(stanza)
	}

	const rejectCall = async (callId: string, callFrom: string) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				from: authState.creds.me!.id,
				to: callFrom
			},
			content: [
				{
					tag: 'reject',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: '0'
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	const sendRetryRequest = async (node: BinaryNode, forceIncludeKeys = false) => {
		const { fullMessage } = decodeMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '')
		const { key: msgKey } = fullMessage
		const msgId = msgKey.id!

		if (messageRetryManager) {
			// Check if we've exceeded max retries using the new system
			if (messageRetryManager.hasExceededMaxRetries(msgId)) {
				logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing')
				messageRetryManager.markRetryFailed(msgId)
				return
			}

			// Increment retry count using new system
			const retryCount = messageRetryManager.incrementRetryCount(msgId)

			// Use the new retry count for the rest of the logic
			const key = `${msgId}:${msgKey?.participant}`
			msgRetryCache.set(key, retryCount)
		} else {
			// Fallback to old system
			const key = `${msgId}:${msgKey?.participant}`
			let retryCount = (await msgRetryCache.get<number>(key)) || 0
			if (retryCount >= maxMsgRetryCount) {
				logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
				msgRetryCache.del(key)
				return
			}

			retryCount += 1
			await msgRetryCache.set(key, retryCount)
		}

		const key = `${msgId}:${msgKey?.participant}`
		const retryCount = (await msgRetryCache.get<number>(key)) || 1

		const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
		const fromJid = node.attrs.from!

		// Check if we should recreate the session
		let shouldRecreateSession = false
		let recreateReason = ''

		if (enableAutoSessionRecreation && messageRetryManager) {
			try {
				// Check if we have a session with this JID
				const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid)
				const hasSession = await signalRepository.validateSession(fromJid)
				const result = messageRetryManager.shouldRecreateSession(fromJid, retryCount, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason

				if (shouldRecreateSession) {
					logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry')
					// Delete existing session to force recreation
					await authState.keys.set({ session: { [sessionId]: null } })
					forceIncludeKeys = true
				}
			} catch (error) {
				logger.warn({ error, fromJid }, 'failed to check session recreation')
			}
		}

		if (retryCount <= 2) {
			// Use new retry manager for phone requests if available
			if (messageRetryManager) {
				// Schedule phone request with delay (like whatsmeow)
				messageRetryManager.schedulePhoneRequest(msgId, async () => {
					try {
						const requestId = await requestPlaceholderResend(msgKey)
						logger.debug(
							`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`
						)
					} catch (error) {
						logger.warn({ error, msgId }, 'failed to send scheduled phone request')
					}
				})
			} else {
				// Fallback to immediate request
				const msgId = await requestPlaceholderResend(msgKey)
				logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`)
			}
		}

		const deviceIdentity = encodeSignedDeviceIdentity(account!, true)
		await authState.keys.transaction(async () => {
			const receipt: BinaryNode = {
				tag: 'receipt',
				attrs: {
					id: msgId,
					type: 'retry',
					to: node.attrs.from!
				},
				content: [
					{
						tag: 'retry',
						attrs: {
							count: retryCount.toString(),
							id: node.attrs.id!,
							t: node.attrs.t!,
							v: '1',
							// ADD ERROR FIELD
							error: '0'
						}
					},
					{
						tag: 'registration',
						attrs: {},
						content: encodeBigEndian(authState.creds.registrationId)
					}
				]
			}

			if (node.attrs.recipient) {
				receipt.attrs.recipient = node.attrs.recipient
			}

			if (node.attrs.participant) {
				receipt.attrs.participant = node.attrs.participant
			}

			if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
				const { update, preKeys } = await getNextPreKeys(authState, 1)

				const [keyId] = Object.keys(preKeys)
				const key = preKeys[+keyId!]

				const content = receipt.content! as BinaryNode[]
				content.push({
					tag: 'keys',
					attrs: {},
					content: [
						{ tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
						{ tag: 'identity', attrs: {}, content: identityKey.public },
						xmppPreKey(key!, +keyId!),
						xmppSignedPreKey(signedPreKey),
						{ tag: 'device-identity', attrs: {}, content: deviceIdentity }
					]
				})

				ev.emit('creds.update', update)
			}

			await sendNode(receipt)

			logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
		}, authState?.creds?.me?.id || 'sendRetryRequest')
	}

	const handleEncryptNotification = async (node: BinaryNode) => {
		const from = node.attrs.from
		if (from === S_WHATSAPP_NET) {
			const countChild = getBinaryNodeChild(node, 'count')
			const count = +countChild!.attrs.value!
			const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

			logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if (shouldUploadMorePreKeys) {
				await uploadPreKeys()
			}
		} else {
			const identityNode = getBinaryNodeChild(node, 'identity')
			if (identityNode) {
				logger.info({ jid: from }, 'identity changed')
				// not handling right now
				// signal will override new identity anyway
			} else {
				logger.info({ node }, 'unknown encrypt notification')
			}
		}
	}

	const handleGroupNotification = (fullNode: BinaryNode, child: BinaryNode, msg: Partial<WAMessage>) => {
		// TODO: Support PN/LID (Here is only LID now)

		const actingParticipantLid = fullNode.attrs.participant
		const actingParticipantPn = fullNode.attrs.participant_pn

		const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid!
		const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn!

		switch (child?.tag) {
			case 'create':
				const metadata = extractGroupMetadata(child)

				msg.messageStubType = WAMessageStubType.GROUP_CREATE
				msg.messageStubParameters = [metadata.subject]
				msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn }

				ev.emit('chats.upsert', [
					{
						id: metadata.id,
						name: metadata.subject,
						conversationTimestamp: metadata.creation
					}
				])
				ev.emit('groups.upsert', [
					{
						...metadata,
						author: actingParticipantLid,
						authorPn: actingParticipantPn
					}
				])
				break
			case 'ephemeral':
			case 'not_ephemeral':
				msg.message = {
					protocolMessage: {
						type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
						ephemeralExpiration: +(child.attrs.expiration || 0)
					}
				}
				break
			case 'modify':
				const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid!)
				msg.messageStubParameters = oldNumber || []
				msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
				break
			case 'promote':
			case 'demote':
			case 'remove':
			case 'add':
			case 'leave':
				const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
				msg.messageStubType = WAMessageStubType[stubType as keyof typeof WAMessageStubType]

				const participants = getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
					// TODO: Store LID MAPPINGS
					return {
						id: attrs.jid!,
						phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
						lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
						admin: (attrs.type || null) as GroupParticipant['admin']
					}
				})

				if (
					participants.length === 1 &&
					// if recv. "remove" message and sender removed themselves
					// mark as left
					(areJidsSameUser(participants[0]!.id, actingParticipantLid) ||
						areJidsSameUser(participants[0]!.id, actingParticipantPn)) &&
					child.tag === 'remove'
				) {
					msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
				}

				msg.messageStubParameters = participants.map(a => JSON.stringify(a))
				break
			case 'subject':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
				msg.messageStubParameters = [child.attrs.subject!]
				break
			case 'description':
				const description = getBinaryNodeChild(child, 'body')?.content?.toString()
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION
				msg.messageStubParameters = description ? [description] : undefined
				break
			case 'announcement':
			case 'not_announcement':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
				msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off']
				break
			case 'locked':
			case 'unlocked':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
				msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off']
				break
			case 'invite':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK
				msg.messageStubParameters = [child.attrs.code!]
				break
			case 'member_add_mode':
				const addMode = child.content
				if (addMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE
					msg.messageStubParameters = [addMode.toString()]
				}

				break
			case 'membership_approval_mode':
				const approvalMode = getBinaryNodeChild(child, 'group_join')
				if (approvalMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
					msg.messageStubParameters = [approvalMode.attrs.state!]
				}

				break
			case 'created_membership_requests':
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					'created',
					child.attrs.request_method!
				]
				break
			case 'revoked_membership_requests':
				const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid)
				// TODO: LIDMAPPING SUPPORT
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					isDenied ? 'revoked' : 'rejected'
				]
				break
		}
	}

	const processNotification = async (node: BinaryNode) => {
		const result: Partial<WAMessage> = {}
		const [child] = getAllBinaryNodeChildren(node)
		const nodeType = node.attrs.type
		const from = jidNormalizedUser(node.attrs.from)

		switch (nodeType) {
			case 'privacy_token':
				const tokenList = getBinaryNodeChildren(child, 'token')
				for (const { attrs, content } of tokenList) {
					const jid = attrs.jid
					ev.emit('chats.update', [
						{
							id: jid,
							tcToken: content as Buffer
						}
					])

					logger.debug({ jid }, 'got privacy token update')
				}

				break
			case 'newsletter':
				await handleNewsletterNotification(node)
				break
			case 'mex':
				await handleMexNewsletterNotification(node)
				break
			case 'w:gp2':
				// TODO: HANDLE PARTICIPANT_PN
				handleGroupNotification(node, child!, result)
				break
			case 'mediaretry':
				const event = decodeMediaRetryNode(node)
				ev.emit('messages.media-update', [event])
				break
			case 'encrypt':
				await handleEncryptNotification(node)
				break
			case 'devices':
				const devices = getBinaryNodeChildren(child, 'device')
				if (
					areJidsSameUser(child!.attrs.jid, authState.creds.me!.id) ||
					areJidsSameUser(child!.attrs.lid, authState.creds.me!.lid)
				) {
					const deviceData = devices.map(d => ({ id: d.attrs.jid, lid: d.attrs.lid }))
					logger.info({ deviceData }, 'my own devices changed')
				}

				//TODO: drop a new event, add hashes

				break
			case 'server_sync':
				const update = getBinaryNodeChild(node, 'collection')
				if (update) {
					const name = update.attrs.name as WAPatchName
					await resyncAppState([name], false)
				}

				break
			case 'picture':
				const setPicture = getBinaryNodeChild(node, 'set')
				const delPicture = getBinaryNodeChild(node, 'delete')

				ev.emit('contacts.update', [
					{
						id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
						imgUrl: setPicture ? 'changed' : 'removed'
					}
				])

				if (isJidGroup(from)) {
					const node = setPicture || delPicture
					result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON

					if (setPicture) {
						result.messageStubParameters = [setPicture.attrs.id!]
					}

					result.participant = node?.attrs.author
					result.key = {
						...(result.key || {}),
						participant: setPicture?.attrs.author
					}
				}

				break
			case 'account_sync':
				if (child!.tag === 'disappearing_mode') {
					const newDuration = +child!.attrs.duration!
					const timestamp = +child!.attrs.t!

					logger.info({ newDuration }, 'updated account disappearing mode')

					ev.emit('creds.update', {
						accountSettings: {
							...authState.creds.accountSettings,
							defaultDisappearingMode: {
								ephemeralExpiration: newDuration,
								ephemeralSettingTimestamp: timestamp
							}
						}
					})
				} else if (child!.tag === 'blocklist') {
					const blocklists = getBinaryNodeChildren(child, 'item')

					for (const { attrs } of blocklists) {
						const blocklist = [attrs.jid!]
						const type = attrs.action === 'block' ? 'add' : 'remove'
						ev.emit('blocklist.update', { blocklist, type })
					}
				}

				break
			case 'link_code_companion_reg':
				const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg')
				const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'))
				const primaryIdentityPublicKey = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub')
				)
				const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
				)
				const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
				const companionSharedKey = Curve.sharedKey(
					authState.creds.pairingEphemeralKeyPair.private,
					codePairingPublicKey
				)
				const random = randomBytes(32)
				const linkCodeSalt = randomBytes(32)
				const linkCodePairingExpanded = await hkdf(companionSharedKey, 32, {
					salt: linkCodeSalt,
					info: 'link_code_pairing_key_bundle_encryption_key'
				})
				const encryptPayload = Buffer.concat([
					Buffer.from(authState.creds.signedIdentityKey.public),
					primaryIdentityPublicKey,
					random
				])
				const encryptIv = randomBytes(12)
				const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0))
				const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
				const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey)
				const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])
				authState.creds.advSecretKey = (await hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64')
				await query({
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						id: sock.generateMessageTag(),
						xmlns: 'md'
					},
					content: [
						{
							tag: 'link_code_companion_reg',
							attrs: {
								jid: authState.creds.me!.id,
								stage: 'companion_finish'
							},
							content: [
								{
									tag: 'link_code_pairing_wrapped_key_bundle',
									attrs: {},
									content: encryptedPayload
								},
								{
									tag: 'companion_identity_public',
									attrs: {},
									content: authState.creds.signedIdentityKey.public
								},
								{
									tag: 'link_code_pairing_ref',
									attrs: {},
									content: ref
								}
							]
						}
					]
				})
				authState.creds.registered = true
				ev.emit('creds.update', authState.creds)
		}

		if (Object.keys(result).length) {
			return result
		}
	}

	async function decipherLinkPublicKey(data: Uint8Array | Buffer) {
		const buffer = toRequiredBuffer(data)
		const salt = buffer.slice(0, 32)
		const secretKey = await derivePairingCodeKey(authState.creds.pairingCode!, salt)
		const iv = buffer.slice(32, 48)
		const payload = buffer.slice(48, 80)
		return aesDecryptCTR(payload, secretKey, iv)
	}

	function toRequiredBuffer(data: Uint8Array | Buffer | undefined) {
		if (data === undefined) {
			throw new Boom('Invalid buffer', { statusCode: 400 })
		}

		return data instanceof Buffer ? data : Buffer.from(data)
	}

	const willSendMessageAgain = async (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const retryCount = (await msgRetryCache.get<number>(key)) || 0
		return retryCount < maxMsgRetryCount
	}

	const updateSendMessageAgainCount = async (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const newValue = ((await msgRetryCache.get<number>(key)) || 0) + 1
		await msgRetryCache.set(key, newValue)
	}

	const sendMessagesAgain = async (key: WAMessageKey, ids: string[], retryNode: BinaryNode) => {
		const remoteJid = key.remoteJid!
		const participant = key.participant || remoteJid

		const retryCount = +retryNode.attrs.count! || 1

		// Try to get messages from cache first, then fallback to getMessage
		const msgs: (proto.IMessage | undefined)[] = []
		for (const id of ids) {
			let msg: proto.IMessage | undefined

			// Try to get from retry cache first if enabled
			if (messageRetryManager) {
				const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id)
				if (cachedMsg) {
					msg = cachedMsg.message
					logger.debug({ jid: remoteJid, id }, 'found message in retry cache')

					// Mark retry as successful since we found the message
					messageRetryManager.markRetrySuccess(id)
				}
			}

			// Fallback to getMessage if not found in cache
			if (!msg) {
				msg = await getMessage({ ...key, id })
				if (msg) {
					logger.debug({ jid: remoteJid, id }, 'found message via getMessage')
					// Also mark as successful if found via getMessage
					if (messageRetryManager) {
						messageRetryManager.markRetrySuccess(id)
					}
				}
			}

			msgs.push(msg)
		}

		// if it's the primary jid sending the request
		// just re-send the message to everyone
		// prevents the first message decryption failure
		const sendToAll = !jidDecode(participant)?.device

		// Check if we should recreate session for this retry
		let shouldRecreateSession = false
		let recreateReason = ''

		if (enableAutoSessionRecreation && messageRetryManager) {
			try {
				const sessionId = signalRepository.jidToSignalProtocolAddress(participant)

				const hasSession = await signalRepository.validateSession(participant)
				const result = messageRetryManager.shouldRecreateSession(participant, retryCount, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason

				if (shouldRecreateSession) {
					logger.debug({ participant, retryCount, reason: recreateReason }, 'recreating session for outgoing retry')
					await authState.keys.set({ session: { [sessionId]: null } })
				}
			} catch (error) {
				logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry')
			}
		}

		await assertSessions([participant])

		if (isJidGroup(remoteJid)) {
			await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
		}

		logger.debug({ participant, sendToAll, shouldRecreateSession, recreateReason }, 'forced new session for retry recp')

		for (const [i, msg] of msgs.entries()) {
			if (!ids[i]) continue

			if (msg && (await willSendMessageAgain(ids[i], participant))) {
				updateSendMessageAgainCount(ids[i], participant)
				const msgRelayOpts: MessageRelayOptions = { messageId: ids[i] }

				if (sendToAll) {
					msgRelayOpts.useUserDevicesCache = false
				} else {
					msgRelayOpts.participant = {
						jid: participant,
						count: +retryNode.attrs.count!
					}
				}

				await relayMessage(key.remoteJid!, msg, msgRelayOpts)
			} else {
				logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}

	const handleReceipt = async (node: BinaryNode) => {
		const { attrs, content } = node
		const isLid = attrs.from!.includes('lid')
		const isNodeFromMe = areJidsSameUser(
			attrs.participant || attrs.from,
			isLid ? authState.creds.me?.lid : authState.creds.me?.id
		)
		const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)

		const key: proto.IMessageKey = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}

		if (shouldIgnoreJid(remoteJid!) && remoteJid !== '@s.whatsapp.net') {
			logger.debug({ remoteJid }, 'ignoring receipt from jid')
			await sendMessageAck(node)
			return
		}

		const ids = [attrs.id!]
		if (Array.isArray(content)) {
			const items = getBinaryNodeChildren(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id!))
		}

		try {
			await Promise.all([
				processingMutex.mutex(async () => {
					const status = getStatusFromReceiptType(attrs.type)
					if (
						typeof status !== 'undefined' &&
						// basically, we only want to know when a message from us has been delivered to/read by the other person
						// or another device of ours has read some messages
						(status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)
					) {
						if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid!)) {
							if (attrs.participant) {
								const updateKey: keyof MessageUserReceipt =
									status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
								ev.emit(
									'message-receipt.update',
									ids.map(id => ({
										key: { ...key, id },
										receipt: {
											userJid: jidNormalizedUser(attrs.participant),
											[updateKey]: +attrs.t!
										}
									}))
								)
							}
						} else {
							ev.emit(
								'messages.update',
								ids.map(id => ({
									key: { ...key, id },
									update: { status }
								}))
							)
						}
					}

					if (attrs.type === 'retry') {
						// correctly set who is asking for the retry
						key.participant = key.participant || attrs.from
						const retryNode = getBinaryNodeChild(node, 'retry')
						if (ids[0] && key.participant && (await willSendMessageAgain(ids[0], key.participant))) {
							if (key.fromMe) {
								try {
									updateSendMessageAgainCount(ids[0], key.participant)
									logger.debug({ attrs, key }, 'recv retry request')
									await sendMessagesAgain(key, ids, retryNode!)
								} catch (error: unknown) {
									logger.error(
										{ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' },
										'error in sending message again'
									)
								}
							} else {
								logger.info({ attrs, key }, 'recv retry for not fromMe message')
							}
						} else {
							logger.info({ attrs, key }, 'will not send message again, as sent too many times')
						}
					}
				})
			])
		} finally {
			await sendMessageAck(node)
		}
	}

	const handleNotification = async (node: BinaryNode) => {
		const remoteJid = node.attrs.from
		if (shouldIgnoreJid(remoteJid!) && remoteJid !== '@s.whatsapp.net') {
			logger.debug({ remoteJid, id: node.attrs.id }, 'ignored notification')
			await sendMessageAck(node)
			return
		}

		try {
			await Promise.all([
				processingMutex.mutex(async () => {
					const msg = await processNotification(node)
					if (msg) {
						const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me!.id)
						const { senderAlt: participantAlt, addressingMode } = extractAddressingContext(node)
						msg.key = {
							remoteJid,
							fromMe,
							participant: node.attrs.participant,
							participantAlt,
							addressingMode,
							id: node.attrs.id,
							...(msg.key || {})
						}
						msg.participant ??= node.attrs.participant
						msg.messageTimestamp = +node.attrs.t!

						const fullMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
						await upsertMessage(fullMsg, 'append')
					}
				})
			])
		} finally {
			await sendMessageAck(node)
		}
	}

	const handleMessage = async (node: BinaryNode) => {
		if (shouldIgnoreJid(node.attrs.from!) && node.attrs.from !== '@s.whatsapp.net') {
			logger.debug({ key: node.attrs.key }, 'ignored message')
			await sendMessageAck(node, NACK_REASONS.UnhandledError)
			return
		}

		const encNode = getBinaryNodeChild(node, 'enc')

		// TODO: temporary fix for crashes and issues resulting of failed msmsg decryption
		if (encNode && encNode.attrs.type === 'msmsg') {
			logger.debug({ key: node.attrs.key }, 'ignored msmsg')
			await sendMessageAck(node, NACK_REASONS.MissingMessageSecret)
			return
		}

		const {
			fullMessage: msg,
			category,
			author,
			decrypt
		} = decryptMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '', signalRepository, logger)

		const alt = msg.key.participantAlt || msg.key.remoteJidAlt
		// store new mappings we didn't have before
		if (!!alt) {
			const altServer = jidDecode(alt)?.server
			const primaryJid = msg.key.participant || msg.key.remoteJid!
			if (altServer === 'lid') {
				if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }])
					await signalRepository.migrateSession(primaryJid, alt)
				}
			} else {
				await signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
				await signalRepository.migrateSession(alt, primaryJid)
			}
		}

		if (msg.key?.remoteJid && msg.key?.id && messageRetryManager) {
			messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message!)
			logger.debug(
				{
					jid: msg.key.remoteJid,
					id: msg.key.id
				},
				'Added message to recent cache for retry receipts'
			)
		}

		try {
			await processingMutex.mutex(async () => {
				await decrypt()
				// message failed to decrypt
				if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
					if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
						return sendMessageAck(node, NACK_REASONS.ParsingError)
					}

					const errorMessage = msg?.messageStubParameters?.[0] || ''
					const isPreKeyError = errorMessage.includes('PreKey')

					logger.debug(`[handleMessage] Attempting retry request for failed decryption`)

					// Handle both pre-key and normal retries in single mutex
					retryMutex.mutex(async () => {
						try {
							if (!ws.isOpen) {
								logger.debug({ node }, 'Connection closed, skipping retry')
								return
							}

							// Handle pre-key errors with upload and delay
							if (isPreKeyError) {
								logger.info({ error: errorMessage }, 'PreKey error detected, uploading and retrying')

								try {
									logger.debug('Uploading pre-keys for error recovery')
									await uploadPreKeys(5)
									logger.debug('Waiting for server to process new pre-keys')
									await delay(1000)
								} catch (uploadErr) {
									logger.error({ uploadErr }, 'Pre-key upload failed, proceeding with retry anyway')
								}
							}

							const encNode = getBinaryNodeChild(node, 'enc')
							await sendRetryRequest(node, !encNode)
							if (retryRequestDelayMs) {
								await delay(retryRequestDelayMs)
							}
						} catch (err) {
							logger.error({ err, isPreKeyError }, 'Failed to handle retry, attempting basic retry')
							// Still attempt retry even if pre-key upload failed
							try {
								const encNode = getBinaryNodeChild(node, 'enc')
								await sendRetryRequest(node, !encNode)
							} catch (retryErr) {
								logger.error({ retryErr }, 'Failed to send retry after error handling')
							}
						}

						await sendMessageAck(node, NACK_REASONS.UnhandledError)
					})
				} else {
					// no type in the receipt => message delivered
					let type: MessageReceiptType = undefined
					let participant = msg.key.participant
					if (category === 'peer') {
						// special peer message
						type = 'peer_msg'
					} else if (msg.key.fromMe) {
						// message was sent by us from a different device
						type = 'sender'
						// need to specially handle this case
						if (isLidUser(msg.key.remoteJid!) || isLidUser(msg.key.remoteJidAlt)) {
							participant = author // TODO: investigate sending receipts to LIDs and not PNs
						}
					} else if (!sendActiveReceipts) {
						type = 'inactive'
					}

					await sendReceipt(msg.key.remoteJid!, participant!, [msg.key.id!], type)

					// send ack for history message
					const isAnyHistoryMsg = getHistoryMsg(msg.message!)
					if (isAnyHistoryMsg) {
						const jid = jidNormalizedUser(msg.key.remoteJid!)
						await sendReceipt(jid, undefined, [msg.key.id!], 'hist_sync')
					}
				}

				cleanMessage(msg, authState.creds.me!.id, authState.creds.me!.lid!)

				await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
			})
		} catch (error) {
			logger.error({ error, node: binaryNodeToString(node) }, 'error in handling message')
		}
	}

	const handleCall = async (node: BinaryNode) => {
		let status: WACallUpdateType
		const { attrs } = node
		const [infoChild] = getAllBinaryNodeChildren(node)

		if (!infoChild) {
			throw new Boom('Missing call info in call node')
		}

		const callId = infoChild.attrs['call-id']!
		const from = infoChild.attrs.from! || infoChild.attrs['call-creator']!
		status = getCallStatusFromNode(infoChild)

		if (isLidUser(from) && infoChild.tag === 'relaylatency') {
			const verify = await callOfferCache.get(callId)
			if (!verify) {
				status = 'offer'
				const callLid: WACallEvent = {
					chatId: attrs.from!,
					from,
					id: callId,
					date: new Date(+attrs.t! * 1000),
					offline: !!attrs.offline,
					status
				}
				await callOfferCache.set(callId, callLid)
			}
		}

		const call: WACallEvent = {
			chatId: attrs.from!,
			from,
			id: callId,
			date: new Date(+attrs.t! * 1000),
			offline: !!attrs.offline,
			status
		}

		if (status === 'offer') {
			call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
			call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
			call.groupJid = infoChild.attrs['group-jid']
			await callOfferCache.set(call.id, call)
		}

		const existingCall = await callOfferCache.get<WACallEvent>(call.id)

		// use existing call info to populate this event
		if (existingCall) {
			call.isVideo = existingCall.isVideo
			call.isGroup = existingCall.isGroup
		}

		// delete data once call has ended
		if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
			await callOfferCache.del(call.id)
		}

		ev.emit('call', [call])

		await sendMessageAck(node)
	}

	const handleBadAck = async ({ attrs }: BinaryNode) => {
		const key: WAMessageKey = { remoteJid: attrs.from, fromMe: true, id: attrs.id }

		// WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
		// // current hypothesis is that if pash is sent in the ack
		// // it means -- the message hasn't reached all devices yet
		// // we'll retry sending the message here
		// if(attrs.phash) {
		// 	logger.info({ attrs }, 'received phash in ack, resending message...')
		// 	const msg = await getMessage(key)
		// 	if(msg) {
		// 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
		// 	} else {
		// 		logger.warn({ attrs }, 'could not send message again, as it was not found')
		// 	}
		// }

		// error in acknowledgement,
		// device could not display the message
		if (attrs.error) {
			logger.warn({ attrs }, 'received error in ack')
			ev.emit('messages.update', [
				{
					key,
					update: {
						status: WAMessageStatus.ERROR,
						messageStubParameters: [attrs.error]
					}
				}
			])
		}
	}

	/// processes a node with the given function
	/// and adds the task to the existing buffer if we're buffering events
	const processNodeWithBuffer = async <T>(
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode, offline: boolean) => Promise<T>
	) => {
		ev.buffer()
		await execTask()
		ev.flush()

		function execTask() {
			return exec(node, false).catch(err => onUnexpectedError(err, identifier))
		}
	}

	type MessageType = 'message' | 'call' | 'receipt' | 'notification'

	type OfflineNode = {
		type: MessageType
		node: BinaryNode
	}

	const makeOfflineNodeProcessor = () => {
		const nodeProcessorMap: Map<MessageType, (node: BinaryNode) => Promise<void>> = new Map([
			['message', handleMessage],
			['call', handleCall],
			['receipt', handleReceipt],
			['notification', handleNotification]
		])
		const nodes: OfflineNode[] = []
		let isProcessing = false

		const enqueue = (type: MessageType, node: BinaryNode) => {
			nodes.push({ type, node })

			if (isProcessing) {
				return
			}

			isProcessing = true

			const promise = async () => {
				while (nodes.length && ws.isOpen) {
					const { type, node } = nodes.shift()!

					const nodeProcessor = nodeProcessorMap.get(type)

					if (!nodeProcessor) {
						onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node')
						continue
					}

					await nodeProcessor(node)
				}

				isProcessing = false
			}

			promise().catch(error => onUnexpectedError(error, 'processing offline nodes'))
		}

		return { enqueue }
	}

	const offlineNodeProcessor = makeOfflineNodeProcessor()

	const processNode = (
		type: MessageType,
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode) => Promise<void>
	) => {
		const isOffline = !!node.attrs.offline

		if (isOffline) {
			offlineNodeProcessor.enqueue(type, node)
		} else {
			processNodeWithBuffer(node, identifier, exec)
		}
	}

	// recv a message
	ws.on('CB:message', (node: BinaryNode) => {
		processNode('message', node, 'processing message', handleMessage)
	})

	ws.on('CB:call', async (node: BinaryNode) => {
		processNode('call', node, 'handling call', handleCall)
	})

	ws.on('CB:receipt', node => {
		processNode('receipt', node, 'handling receipt', handleReceipt)
	})

	ws.on('CB:notification', async (node: BinaryNode) => {
		processNode('notification', node, 'handling notification', handleNotification)
	})
	ws.on('CB:ack,class:message', (node: BinaryNode) => {
		handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'))
	})

	ev.on('call', ([call]) => {
		if (!call) {
			return
		}

		// missed call + group call notification message generation
		if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
			const msg: WAMessage = {
				key: {
					remoteJid: call.chatId,
					id: call.id,
					fromMe: false
				},
				messageTimestamp: unixTimestampSeconds(call.date)
			}
			if (call.status === 'timeout') {
				if (call.isGroup) {
					msg.messageStubType = call.isVideo
						? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
						: WAMessageStubType.CALL_MISSED_GROUP_VOICE
				} else {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE
				}
			} else {
				msg.message = { call: { callKey: Buffer.from(call.id) } }
			}

			const protoMsg = proto.WebMessageInfo.fromObject(msg) as WAMessage
			upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
		}
	})

	ev.on('connection.update', ({ isOnline }) => {
		if (typeof isOnline !== 'undefined') {
			sendActiveReceipts = isOnline
			logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
		}
	})

	return {
		...sock,
		sendMessageAck,
		sendRetryRequest,
		rejectCall,
		fetchMessageHistory,
		requestPlaceholderResend,
		messageRetryManager
	}
}



================================================
FILE: src/Socket/messages-send.ts
================================================
import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import type {
	AnyMessageContent,
	MediaConnInfo,
	MessageReceiptType,
	MessageRelayOptions,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMessage,
	WAMessageKey
} from '../Types'
import {
	aggregateMessageKeysNotFromMe,
	assertMediaContent,
	bindWaitForEvent,
	decryptMediaRetryData,
	encodeNewsletterMessage,
	encodeSignedDeviceIdentity,
	encodeWAMessage,
	encryptMediaRetryRequest,
	extractDeviceJids,
	generateMessageIDV2,
	generateParticipantHashV2,
	generateWAMessage,
	getStatusCodeForMediaRetry,
	getUrlFromDirectPath,
	getWAUploadToServer,
	MessageRetryManager,
	normalizeMessageContent,
	parseAndInjectE2ESessions,
	unixTimestampSeconds
} from '../Utils'
import { getUrlInfo } from '../Utils/link-preview'
import { makeKeyedMutex } from '../Utils/make-mutex'
import {
	areJidsSameUser,
	type BinaryNode,
	type BinaryNodeAttributes,
	type FullJid,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getServerFromDomainType,
	isHostedLidUser,
	isHostedPnUser,
	isJidGroup,
	isLidUser,
	isPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	type JidWithDevice,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { makeNewsletterSocket } from './newsletter'

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: httpRequestOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
		enableRecentMessageCache,
		maxMsgRetryCount
	} = config
	const sock = makeNewsletterSocket(config)
	const {
		ev,
		authState,
		processingMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		sendNode,
		groupMetadata,
		groupToggleEphemeral
	} = sock

	const userDevicesCache =
		config.userDevicesCache ||
		new NodeCache<JidWithDevice[]>({
			stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
			useClones: false
		})

	const peerSessionsCache = new NodeCache<boolean>({
		stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES,
		useClones: false
	})

	// Initialize message retry manager if enabled
	const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null

	// Prevent race conditions in Signal session encryption by user
	const encryptionMutex = makeKeyedMutex()

	let mediaConn: Promise<MediaConnInfo>
	const refreshMediaConn = async (forceGet = false) => {
		const media = await mediaConn
		if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
			mediaConn = (async () => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET
					},
					content: [{ tag: 'media_conn', attrs: {} }]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')!
				// TODO: explore full length of data that whatsapp provides
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
						hostname: attrs.hostname!,
						maxContentLengthBytes: +attrs.maxContentLengthBytes!
					})),
					auth: mediaConnNode.attrs.auth!,
					ttl: +mediaConnNode.attrs.ttl!,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				return node
			})()
		}

		return mediaConn
	}

	/**
	 * generic send receipt function
	 * used for receipts of phone call, read, delivery etc.
	 * */
	const sendReceipt = async (
		jid: string,
		participant: string | undefined,
		messageIds: string[],
		type: MessageReceiptType
	) => {
		if (!messageIds || messageIds.length === 0) {
			throw new Boom('missing ids in receipt')
		}

		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0]!
			}
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if (isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if (participant) {
				node.attrs.participant = participant
			}
		}

		if (type) {
			node.attrs.type = type
		}

		const remainingMessageIds = messageIds.slice(1)
		if (remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: {},
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async (keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		for (const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async (keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
	}

	/** Device info with wire JID */
	type DeviceWithJid = JidWithDevice & {
		jid: string
	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async (
		jids: string[],
		useCache: boolean,
		ignoreZeroDevices: boolean
	): Promise<DeviceWithJid[]> => {
		const deviceResults: DeviceWithJid[] = []

		if (!useCache) {
			logger.debug('not using cache for devices')
		}

		const toFetch: string[] = []

		const jidsWithUser = jids
			.map(jid => {
				const decoded = jidDecode(jid)
				const user = decoded?.user
				const device = decoded?.device
				const isExplicitDevice = typeof device === 'number' && device >= 0

				if (isExplicitDevice && user) {
					deviceResults.push({
						user,
						device,
						jid
					})
					return null
				}

				jid = jidNormalizedUser(jid)
				return { jid, user }
			})
			.filter(jid => jid !== null)

		let mgetDevices: undefined | Record<string, JidWithDevice[] | undefined>

		if (useCache && userDevicesCache.mget) {
			const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean) as string[]
			mgetDevices = await userDevicesCache.mget(usersToFetch)
		}

		for (const { jid, user } of jidsWithUser) {
			if (useCache) {
				const devices =
					mgetDevices?.[user!] ||
					(userDevicesCache.mget ? undefined : ((await userDevicesCache.get(user!)) as JidWithDevice[]))
				if (devices) {
					const isLidJid = jid.includes('@lid')
					const devicesWithJid = devices.map(d => ({
						...d,
						jid: isLidJid ? jidEncode(d.user, 'lid', d.device) : jidEncode(d.user, 's.whatsapp.net', d.device)
					}))
					deviceResults.push(...devicesWithJid)

					logger.trace({ user }, 'using cache for devices')
				} else {
					toFetch.push(jid)
				}
			} else {
				toFetch.push(jid)
			}
		}

		if (!toFetch.length) {
			return deviceResults
		}

		const requestedLidUsers = new Set<string>()
		for (const jid of toFetch) {
			if (jid.includes('@lid') || jid.includes('@hosted.lid')) {
				const user = jidDecode(jid)?.user
				if (user) requestedLidUsers.add(user)
			}
		}

		const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()

		for (const jid of toFetch) {
			query.withUser(new USyncUser().withId(jid)) // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
		}

		const result = await sock.executeUSyncQuery(query)

		if (result) {
			// TODO: LID MAP this stuff (lid protocol will now return lid with devices)
			const lidResults = result.list.filter(a => !!a.lid)
			if (lidResults.length > 0) {
				logger.trace('Storing LID maps from device call')
				await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid as string, pn: a.id })))
			}

			const extracted = extractDeviceJids(
				result?.list,
				authState.creds.me!.id,
				authState.creds.me!.lid!,
				ignoreZeroDevices
			)
			const deviceMap: { [_: string]: FullJid[] } = {}

			for (const item of extracted) {
				deviceMap[item.user] = deviceMap[item.user] || []
				deviceMap[item.user]?.push(item)
			}

			// Process each user's devices as a group for bulk LID migration
			for (const [user, userDevices] of Object.entries(deviceMap)) {
				const isLidUser = requestedLidUsers.has(user)

				// Process all devices for this user
				for (const item of userDevices) {
					const deterministicServer = getServerFromDomainType(item.server, item.domainType)
					const finalJid = isLidUser
						? jidEncode(user, deterministicServer, item.device)
						: jidEncode(item.user, deterministicServer, item.device)

					deviceResults.push({
						...item,
						jid: finalJid
					})

					logger.debug(
						{
							user: item.user,
							device: item.device,
							finalJid,
							usedLid: isLidUser
						},
						'Processed device with LID priority'
					)
				}
			}

			if (userDevicesCache.mset) {
				// if the cache supports mset, we can set all devices in one go
				await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
			} else {
				for (const key in deviceMap) {
					if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
				}
			}

			const userDeviceUpdates: { [userId: string]: string[] } = {}
			for (const [userId, devices] of Object.entries(deviceMap)) {
				if (devices && devices.length > 0) {
					userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
				}
			}

			if (Object.keys(userDeviceUpdates).length > 0) {
				try {
					await authState.keys.set({ 'device-list': userDeviceUpdates })
					logger.debug(
						{ userCount: Object.keys(userDeviceUpdates).length },
						'stored user device lists for bulk migration'
					)
				} catch (error) {
					logger.warn({ error }, 'failed to store user device lists')
				}
			}
		}

		return deviceResults
	}

	const assertSessions = async (jids: string[]) => {
		let didFetchNewSession = false
		const uniqueJids = [...new Set(jids)] // Deduplicate JIDs
		const jidsRequiringFetch: string[] = []

		logger.debug({ jids }, 'assertSessions call with jids')

		// Check peerSessionsCache and validate sessions using libsignal loadSession
		for (const jid of uniqueJids) {
			const signalId = signalRepository.jidToSignalProtocolAddress(jid)
			const cachedSession = peerSessionsCache.get(signalId)
			if (cachedSession !== undefined) {
				if (cachedSession) {
					continue // Session exists in cache
				}
			} else {
				const sessionValidation = await signalRepository.validateSession(jid)
				const hasSession = sessionValidation.exists
				peerSessionsCache.set(signalId, hasSession)
				if (hasSession) {
					continue
				}
			}

			jidsRequiringFetch.push(jid)
		}

		if (jidsRequiringFetch.length) {
			// LID if mapped, otherwise original
			const wireJids = [
				...jidsRequiringFetch.filter(jid => !!jid.includes('@lid') || !!jid.includes('@hosted.lid')),
				...(
					(await signalRepository.lidMapping.getLIDsForPNs(
						jidsRequiringFetch.filter(jid => !!jid.includes('@s.whatsapp.net') || !!jid.includes('@hosted'))
					)) || []
				).map(a => a.lid)
			]

			logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'encrypt',
					type: 'get',
					to: S_WHATSAPP_NET
				},
				content: [
					{
						tag: 'key',
						attrs: {},
						content: wireJids.map(jid => ({
							tag: 'user',
							attrs: { jid }
						}))
					}
				]
			})
			await parseAndInjectE2ESessions(result, signalRepository)
			didFetchNewSession = true

			// Cache fetched sessions using wire JIDs
			for (const wireJid of wireJids) {
				const signalId = signalRepository.jidToSignalProtocolAddress(wireJid)
				peerSessionsCache.set(signalId, true)
			}
		}

		return didFetchNewSession
	}

	const sendPeerDataOperationMessage = async (
		pdoMessage: proto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const protocolMessage: proto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}

		const meJid = jidNormalizedUser(authState.creds.me.id)

		const msgId = await relayMessage(meJid, protocolMessage, {
			additionalAttributes: {
				category: 'peer',

				push_priority: 'high_force'
			},
			additionalNodes: [
				{
					tag: 'meta',
					attrs: { appdata: 'default' }
				}
			]
		})

		return msgId
	}

	const createParticipantNodes = async (
		recipientJids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs'],
		dsmMessage?: proto.IMessage
	) => {
		if (!recipientJids.length) {
			return { nodes: [] as BinaryNode[], shouldIncludeDeviceIdentity: false }
		}

		const patched = await patchMessageBeforeSending(message, recipientJids)
		const patchedMessages = Array.isArray(patched)
			? patched
			: recipientJids.map(jid => ({ recipientJid: jid, message: patched }))

		let shouldIncludeDeviceIdentity = false
		const meId = authState.creds.me!.id
		const meLid = authState.creds.me?.lid
		const meLidUser = meLid ? jidDecode(meLid)?.user : null

		const encryptionPromises = (patchedMessages as any).map(
			async ({ recipientJid: jid, message: patchedMessage }: any) => {
				if (!jid) return null
				let msgToEncrypt = patchedMessage
				if (dsmMessage) {
					const { user: targetUser } = jidDecode(jid)!
					const { user: ownPnUser } = jidDecode(meId)!
					const ownLidUser = meLidUser
					const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser)
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
					if (isOwnUser && !isExactSenderDevice) {
						msgToEncrypt = dsmMessage
						logger.debug({ jid, targetUser }, 'Using DSM for own device')
					}
				}

				const bytes = encodeWAMessage(msgToEncrypt)
				const mutexKey = jid
				const node = await encryptionMutex.mutex(mutexKey, async () => {
					const { type, ciphertext } = await signalRepository.encryptMessage({
						jid,
						data: bytes
					})
					if (type === 'pkmsg') {
						shouldIncludeDeviceIdentity = true
					}

					return {
						tag: 'to',
						attrs: { jid },
						content: [
							{
								tag: 'enc',
								attrs: {
									v: '2',
									type,
									...(extraAttrs || {})
								},
								content: ciphertext
							}
						]
					}
				})
				return node
			}
		)

		const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null) as BinaryNode[]
		return { nodes, shouldIncludeDeviceIdentity }
	}

	const relayMessage = async (
		jid: string,
		message: proto.IMessage,
		{
			messageId: msgId,
			participant,
			additionalAttributes,
			additionalNodes,
			useUserDevicesCache,
			useCachedGroupMetadata,
			statusJidList
		}: MessageRelayOptions
	) => {
		const meId = authState.creds.me!.id
		const meLid = authState.creds.me?.lid
		const isRetryResend = Boolean(participant?.jid)
		let shouldIncludeDeviceIdentity = isRetryResend
		const statusJid = 'status@broadcast'

		const { user, server } = jidDecode(jid)!
		const isGroup = server === 'g.us'
		const isStatus = jid === statusJid
		const isLid = server === 'lid'
		const isNewsletter = server === 'newsletter'
		const finalJid = jid

		msgId = msgId || generateMessageIDV2(meId)
		useUserDevicesCache = useUserDevicesCache !== false
		useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

		const participants: BinaryNode[] = []
		const destinationJid = !isStatus ? finalJid : statusJid
		const binaryNodeContent: BinaryNode[] = []
		const devices: DeviceWithJid[] = []

		const meMsg: proto.IMessage = {
			deviceSentMessage: {
				destinationJid,
				message
			},
			messageContextInfo: message.messageContextInfo
		}

		const extraAttrs: BinaryNodeAttributes = {}

		if (participant) {
			if (!isGroup && !isStatus) {
				additionalAttributes = { ...additionalAttributes, device_fanout: 'false' }
			}

			const { user, device } = jidDecode(participant.jid)!
			devices.push({
				user,
				device,
				jid: participant.jid
			})
		}

		await authState.keys.transaction(async () => {
			const mediaType = getMediaType(message)
			if (mediaType) {
				extraAttrs['mediatype'] = mediaType
			}

			if (isNewsletter) {
				const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
				const bytes = encodeNewsletterMessage(patched as proto.IMessage)
				binaryNodeContent.push({
					tag: 'plaintext',
					attrs: {},
					content: bytes
				})
				const stanza: BinaryNode = {
					tag: 'message',
					attrs: {
						to: jid,
						id: msgId,
						type: getMessageType(message),
						...(additionalAttributes || {})
					},
					content: binaryNodeContent
				}
				logger.debug({ msgId }, `sending newsletter message to ${jid}`)
				await sendNode(stanza)
				return
			}

			if (normalizeMessageContent(message)?.pinInChatMessage) {
				extraAttrs['decrypt-fail'] = 'hide' // todo: expand for reactions and other types
			}

			if (isGroup || isStatus) {
				const [groupData, senderKeyMap] = await Promise.all([
					(async () => {
						let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined // todo: should we rely on the cache specially if the cache is outdated and the metadata has new fields?
						if (groupData && Array.isArray(groupData?.participants)) {
							logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
						} else if (!isStatus) {
							groupData = await groupMetadata(jid) // TODO: start storing group participant list + addr mode in Signal & stop relying on this
						}

						return groupData
					})(),
					(async () => {
						if (!participant && !isStatus) {
							// what if sender memory is less accurate than the cached metadata
							// on participant change in group, we should do sender memory manipulation
							const result = await authState.keys.get('sender-key-memory', [jid]) // TODO: check out what if the sender key memory doesn't include the LID stuff now?
							return result[jid] || {}
						}

						return {}
					})()
				])

				if (!participant) {
					const participantsList = []
					if (isStatus) {
						if (statusJidList?.length) participantsList.push(...statusJidList)
					} else {
						// default to LID based groups
						let groupAddressingMode = 'lid'
						if (groupData) {
							participantsList.push(...groupData.participants.map(p => p.id))
							groupAddressingMode = groupData?.addressingMode || groupAddressingMode
						}

						// default to lid addressing mode in a group
						additionalAttributes = {
							...additionalAttributes,
							addressing_mode: groupAddressingMode
						}
					}

					const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
					devices.push(...additionalDevices)
				}

				if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
					additionalAttributes = {
						...additionalAttributes,
						expiration: groupData.ephemeralDuration.toString()
					}
				}

				const patched = await patchMessageBeforeSending(message)
				if (Array.isArray(patched)) {
					throw new Boom('Per-jid patching is not supported in groups')
				}

				const bytes = encodeWAMessage(patched)
				const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'lid'
				const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId

				const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
					group: destinationJid,
					data: bytes,
					meId: groupSenderIdentity
				})

				const senderKeyRecipients: string[] = []
				for (const device of devices) {
					const deviceJid = device.jid
					const hasKey = !!senderKeyMap[deviceJid]
					if (
						(!hasKey || !!participant) &&
						!isHostedLidUser(deviceJid) &&
						!isHostedPnUser(deviceJid) &&
						device.device !== 99
					) {
						//todo: revamp all this logic
						// the goal is to follow with what I said above for each group, and instead of a true false map of ids, we can set an array full of those the app has already sent pkmsgs
						senderKeyRecipients.push(deviceJid)
						senderKeyMap[deviceJid] = true
					}
				}

				if (senderKeyRecipients.length) {
					logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key')

					const senderKeyMsg: proto.IMessage = {
						senderKeyDistributionMessage: {
							axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
							groupId: destinationJid
						}
					}

					const senderKeySessionTargets = senderKeyRecipients
					await assertSessions(senderKeySessionTargets)

					const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs)
					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

					participants.push(...result.nodes)
				}

				if (isRetryResend) {
					const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
						data: bytes,
						jid: participant?.jid!
					})

					binaryNodeContent.push({
						tag: 'enc',
						attrs: {
							v: '2',
							type,
							count: participant!.count.toString()
						},
						content: encryptedContent
					})
				} else {
					binaryNodeContent.push({
						tag: 'enc',
						attrs: { v: '2', type: 'skmsg', ...extraAttrs },
						content: ciphertext
					})

					await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
				}
			} else {
				// ADDRESSING CONSISTENCY: Match own identity to conversation context
				// TODO: investigate if this is true
				let ownId = meId
				if (isLid && meLid) {
					ownId = meLid
					logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation')
				} else {
					logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation')
				}

				const { user: ownUser } = jidDecode(ownId)!

				if (!participant) {
					const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
					devices.push({
						user,
						device: 0,
						jid: jidEncode(user, targetUserServer, 0) // rajeh, todo: this entire logic is convoluted and weird.
					})

					if (user !== ownUser) {
						const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
						const ownUserForAddressing = isLid && meLid ? jidDecode(meLid)!.user : jidDecode(meId)!.user

						devices.push({
							user: ownUserForAddressing,
							device: 0,
							jid: jidEncode(ownUserForAddressing, ownUserServer, 0)
						})
					}

					if (additionalAttributes?.['category'] !== 'peer') {
						// Clear placeholders and enumerate actual devices
						devices.length = 0

						// Use conversation-appropriate sender identity
						const senderIdentity =
							isLid && meLid
								? jidEncode(jidDecode(meLid)?.user!, 'lid', undefined)
								: jidEncode(jidDecode(meId)?.user!, 's.whatsapp.net', undefined)

						// Enumerate devices for sender and target with consistent addressing
						const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false)
						devices.push(...sessionDevices)

						logger.debug(
							{
								deviceCount: devices.length,
								devices: devices.map(d => `${d.user}:${d.device}@${jidDecode(d.jid)?.server}`)
							},
							'Device enumeration complete with unified addressing'
						)
					}
				}

				const allRecipients: string[] = []
				const meRecipients: string[] = []
				const otherRecipients: string[] = []
				const { user: mePnUser } = jidDecode(meId)!
				const { user: meLidUser } = meLid ? jidDecode(meLid)! : { user: null }

				for (const { user, jid } of devices) {
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
					if (isExactSenderDevice) {
						logger.debug({ jid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)')
						continue
					}

					// Check if this is our device (could match either PN or LID user)
					const isMe = user === mePnUser || user === meLidUser

					if (isMe) {
						meRecipients.push(jid)
					} else {
						otherRecipients.push(jid)
					}

					allRecipients.push(jid)
				}

				await assertSessions(allRecipients)

				const [
					{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
					{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
				] = await Promise.all([
					// For own devices: use DSM if available (1:1 chats only)
					createParticipantNodes(meRecipients, meMsg || message, extraAttrs),
					createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
				])
				participants.push(...meNodes)
				participants.push(...otherNodes)

				if (meRecipients.length > 0 || otherRecipients.length > 0) {
					extraAttrs['phash'] = generateParticipantHashV2([...meRecipients, ...otherRecipients])
				}

				shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
			}

			if (participants.length) {
				if (additionalAttributes?.['category'] === 'peer') {
					const peerNode = participants[0]?.content?.[0] as BinaryNode
					if (peerNode) {
						binaryNodeContent.push(peerNode) // push only enc
					}
				} else {
					binaryNodeContent.push({
						tag: 'participants',
						attrs: {},

						content: participants
					})
				}
			}

			const stanza: BinaryNode = {
				tag: 'message',
				attrs: {
					id: msgId,
					to: destinationJid,
					type: getMessageType(message),
					...(additionalAttributes || {})
				},
				content: binaryNodeContent
			}

			// if the participant to send to is explicitly specified (generally retry recp)
			// ensure the message is only sent to that person
			// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
			if (participant) {
				if (isJidGroup(destinationJid)) {
					stanza.attrs.to = destinationJid
					stanza.attrs.participant = participant.jid
				} else if (areJidsSameUser(participant.jid, meId)) {
					stanza.attrs.to = participant.jid
					stanza.attrs.recipient = destinationJid
				} else {
					stanza.attrs.to = participant.jid
				}
			} else {
				stanza.attrs.to = destinationJid
			}

			if (shouldIncludeDeviceIdentity) {
				;(stanza.content as BinaryNode[]).push({
					tag: 'device-identity',
					attrs: {},
					content: encodeSignedDeviceIdentity(authState.creds.account!, true)
				})

				logger.debug({ jid }, 'adding device identity')
			}

			if (additionalNodes && additionalNodes.length > 0) {
				;(stanza.content as BinaryNode[]).push(...additionalNodes)
			}

			logger.debug({ msgId }, `sending message to ${participants.length} devices`)

			await sendNode(stanza)

			// Add message to retry cache if enabled
			if (messageRetryManager && !participant) {
				messageRetryManager.addRecentMessage(destinationJid, msgId, message)
			}
		}, meId)

		return msgId
	}

	const getMessageType = (message: proto.IMessage) => {
		if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
			return 'poll'
		}

		if (message.eventMessage) {
			return 'event'
		}

		if (getMediaType(message) !== '') {
			return 'media'
		}

		return 'text'
	}

	const getMediaType = (message: proto.IMessage) => {
		if (message.imageMessage) {
			return 'image'
		} else if (message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video'
		} else if (message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio'
		} else if (message.contactMessage) {
			return 'vcard'
		} else if (message.documentMessage) {
			return 'document'
		} else if (message.contactsArrayMessage) {
			return 'contact_array'
		} else if (message.liveLocationMessage) {
			return 'livelocation'
		} else if (message.stickerMessage) {
			return 'sticker'
		} else if (message.listMessage) {
			return 'list'
		} else if (message.listResponseMessage) {
			return 'list_response'
		} else if (message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if (message.orderMessage) {
			return 'order'
		} else if (message.productMessage) {
			return 'product'
		} else if (message.interactiveResponseMessage) {
			return 'native_flow_response'
		} else if (message.groupInviteMessage) {
			return 'url'
		}

		return ''
	}

	const getPrivacyTokens = async (jids: string[]) => {
		const t = unixTimestampSeconds().toString()
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy'
			},
			content: [
				{
					tag: 'tokens',
					attrs: {},
					content: jids.map(jid => ({
						tag: 'token',
						attrs: {
							jid: jidNormalizedUser(jid),
							t,
							type: 'trusted_contact'
						}
					}))
				}
			]
		})

		return result
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

	return {
		...sock,
		getPrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		waUploadToServer,
		fetchPrivacySettings,
		sendPeerDataOperationMessage,
		createParticipantNodes,
		getUSyncDevices,
		messageRetryManager,
		updateMediaMessage: async (message: WAMessage) => {
			const content = assertMediaContent(message.message)
			const mediaKey = content.mediaKey!
			const meId = authState.creds.me!.id
			const node = await encryptMediaRetryRequest(message.key, mediaKey, meId)

			let error: Error | undefined = undefined
			await Promise.all([
				sendNode(node),
				waitForMsgMediaUpdate(async update => {
					const result = update.find(c => c.key.id === message.key.id)
					if (result) {
						if (result.error) {
							error = result.error
						} else {
							try {
								const media = await decryptMediaRetryData(result.media!, mediaKey, result.key.id!)
								if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
									const resultStr = proto.MediaRetryNotification.ResultType[media.result!]
									throw new Boom(`Media re-upload failed by device (${resultStr})`, {
										data: media,
										statusCode: getStatusCodeForMediaRetry(media.result!) || 404
									})
								}

								content.directPath = media.directPath
								content.url = getUrlFromDirectPath(content.directPath!)

								logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
							} catch (err: any) {
								error = err
							}
						}

						return true
					}
				})
			])

			if (error) {
				throw error
			}

			ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])

			return message
		},
		sendMessage: async (jid: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) => {
			const userJid = authState.creds.me!.id
			if (
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value =
					typeof disappearingMessagesInChat === 'boolean'
						? disappearingMessagesInChat
							? WA_DEFAULT_EPHEMERAL
							: 0
						: disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else {
				const fullMsg = await generateWAMessage(jid, content, {
					logger,
					userJid,
					getUrlInfo: text =>
						getUrlInfo(text, {
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: {
								timeout: 3_000,
								...(httpRequestOptions || {})
							},
							logger,
							uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
						}),
					//TODO: CACHE
					getProfilePicUrl: sock.profilePictureUrl,
					getCallLink: sock.createCallLink,
					upload: waUploadToServer,
					mediaCache: config.mediaCache,
					options: config.options,
					messageId: generateMessageIDV2(sock.user?.id),
					...options
				})
				const isEventMsg = 'event' in content && !!content.event
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const isPollMessage = 'poll' in content && !!content.poll
				const additionalAttributes: BinaryNodeAttributes = {}
				const additionalNodes: BinaryNode[] = []
				// required for delete
				if (isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if (isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				} else if (isEditMsg) {
					additionalAttributes.edit = '1'
				} else if (isPinMsg) {
					additionalAttributes.edit = '2'
				} else if (isPollMessage) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							polltype: 'creation'
						}
					} as BinaryNode)
				} else if (isEventMsg) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							event_type: 'creation'
						}
					} as BinaryNode)
				}

				await relayMessage(jid, fullMsg.message!, {
					messageId: fullMsg.key.id!,
					useCachedGroupMetadata: options.useCachedGroupMetadata,
					additionalAttributes,
					statusJidList: options.statusJidList,
					additionalNodes
				})
				if (config.emitOwnEvents) {
					process.nextTick(() => {
						processingMutex.mutex(() => upsertMessage(fullMsg, 'append'))
					})
				}

				return fullMsg
			}
		}
	}
}



================================================
FILE: src/Socket/mex.ts
================================================
import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = getBinaryNodeChild(result, 'result')
	if (child?.content) {
		const data = JSON.parse(child.content.toString())

		if (data.errors && data.errors.length > 0) {
			const errorMessages = data.errors.map((err: Error) => err.message || 'Unknown error').join(', ')
			const firstError = data.errors[0]
			const errorCode = firstError.extensions?.error_code || 400
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}

		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') {
			return response as T
		}
	}

	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ')
	throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
}



================================================
FILE: src/Socket/newsletter.ts
================================================
import type { NewsletterCreateResponse, SocketConfig, WAMediaUpload } from '../Types'
import type { NewsletterMetadata, NewsletterUpdate } from '../Types'
import { QueryIds, XWAPaths } from '../Types'
import { generateProfilePicture } from '../Utils/messages-media'
import { getBinaryNodeChild } from '../WABinary'
import { makeGroupsSocket } from './groups'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'

const parseNewsletterCreateResponse = (response: NewsletterCreateResponse): NewsletterMetadata => {
	const { id, thread_metadata: thread, viewer_metadata: viewer } = response
	return {
		id: id,
		owner: undefined,
		name: thread.name.text,
		creation_time: parseInt(thread.creation_time, 10),
		description: thread.description.text,
		invite: thread.invite,
		subscribers: parseInt(thread.subscribers_count, 10),
		verification: thread.verification,
		picture: {
			id: thread.picture.id,
			directPath: thread.picture.direct_path
		},
		mute_state: viewer.mute
	}
}

const parseNewsletterMetadata = (result: unknown): NewsletterMetadata | null => {
	if (typeof result !== 'object' || result === null) {
		return null
	}

	if ('id' in result && typeof result.id === 'string') {
		return result as NewsletterMetadata
	}

	if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
		return result.result as NewsletterMetadata
	}

	return null
}

export const makeNewsletterSocket = (config: SocketConfig) => {
	const sock = makeGroupsSocket(config)
	const { query, generateMessageTag } = sock

	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		return genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)
	}

	const newsletterUpdate = async (jid: string, updates: NewsletterUpdate) => {
		const variables = {
			newsletter_id: jid,
			updates: {
				...updates,
				settings: null
			}
		}
		return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
	}

	return {
		...sock,
		newsletterCreate: async (name: string, description?: string): Promise<NewsletterMetadata> => {
			const variables = {
				input: {
					name,
					description: description ?? null
				}
			}
			const rawResponse = await executeWMexQuery<NewsletterCreateResponse>(
				variables,
				QueryIds.CREATE,
				XWAPaths.xwa2_newsletter_create
			)
			return parseNewsletterCreateResponse(rawResponse)
		},

		newsletterUpdate,

		newsletterSubscribers: async (jid: string) => {
			return executeWMexQuery<{ subscribers: number }>(
				{ newsletter_id: jid },
				QueryIds.SUBSCRIBERS,
				XWAPaths.xwa2_newsletter_subscribers
			)
		},

		newsletterMetadata: async (type: 'invite' | 'jid', key: string) => {
			const variables = {
				fetch_creation_time: true,
				fetch_full_image: true,
				fetch_viewer_metadata: true,
				input: {
					key,
					type: type.toUpperCase()
				}
			}
			const result = await executeWMexQuery<unknown>(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
			return parseNewsletterMetadata(result)
		},

		newsletterFollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_follow)
		},

		newsletterUnfollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_unfollow)
		},

		newsletterMute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2)
		},

		newsletterUnmute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2)
		},

		newsletterUpdateName: async (jid: string, name: string) => {
			return await newsletterUpdate(jid, { name })
		},

		newsletterUpdateDescription: async (jid: string, description: string) => {
			return await newsletterUpdate(jid, { description })
		},

		newsletterUpdatePicture: async (jid: string, content: WAMediaUpload) => {
			const { img } = await generateProfilePicture(content)
			return await newsletterUpdate(jid, { picture: img.toString('base64') })
		},

		newsletterRemovePicture: async (jid: string) => {
			return await newsletterUpdate(jid, { picture: '' })
		},

		newsletterReactMessage: async (jid: string, serverId: string, reaction?: string) => {
			await query({
				tag: 'message',
				attrs: {
					to: jid,
					...(reaction ? {} : { edit: '7' }),
					type: 'reaction',
					server_id: serverId,
					id: generateMessageTag()
				},
				content: [
					{
						tag: 'reaction',
						attrs: reaction ? { code: reaction } : {}
					}
				]
			})
		},

		newsletterFetchMessages: async (jid: string, count: number, since: number, after: number) => {
			const messageUpdateAttrs: { count: string; since?: string; after?: string } = {
				count: count.toString()
			}
			if (typeof since === 'number') {
				messageUpdateAttrs.since = since.toString()
			}

			if (after) {
				messageUpdateAttrs.after = after.toString()
			}

			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'get',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'message_updates',
						attrs: messageUpdateAttrs
					}
				]
			})
			return result
		},

		subscribeNewsletterUpdates: async (jid: string): Promise<{ duration: string } | null> => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [{ tag: 'live_updates', attrs: {}, content: [] }]
			})
			const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
			const duration = liveUpdatesNode?.attrs?.duration
			return duration ? { duration: duration } : null
		},

		newsletterAdminCount: async (jid: string): Promise<number> => {
			const response = await executeWMexQuery<{ admin_count: number }>(
				{ newsletter_id: jid },
				QueryIds.ADMIN_COUNT,
				XWAPaths.xwa2_newsletter_admin_count
			)
			return response.admin_count
		},

		newsletterChangeOwner: async (jid: string, newOwnerJid: string) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: newOwnerJid },
				QueryIds.CHANGE_OWNER,
				XWAPaths.xwa2_newsletter_change_owner
			)
		},

		newsletterDemote: async (jid: string, userJid: string) => {
			await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote)
		},

		newsletterDelete: async (jid: string) => {
			await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2)
		}
	}
}

export type NewsletterSocket = ReturnType<typeof makeNewsletterSocket>



================================================
FILE: src/Socket/socket.ts
================================================
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { URL } from 'url'
import { promisify } from 'util'
import { proto } from '../../WAProto/index.js'
import {
	DEF_CALLBACK_PREFIX,
	DEF_TAG_PREFIX,
	INITIAL_PREKEY_COUNT,
	MIN_PREKEY_COUNT,
	MIN_UPLOAD_INTERVAL,
	NOISE_WA_HEADER,
	UPLOAD_TIMEOUT
} from '../Defaults'
import type { LIDMapping, SocketConfig } from '../Types'
import { DisconnectReason } from '../Types'
import {
	addTransactionCapability,
	aesEncryptCTR,
	bindWaitForConnectionUpdate,
	bytesToCrockford,
	configureSuccessfulPairing,
	Curve,
	derivePairingCodeKey,
	generateLoginNode,
	generateMdTagPrefix,
	generateRegistrationNode,
	getCodeFromWSError,
	getErrorCodeFromStreamError,
	getNextPreKeysNode,
	makeEventBuffer,
	makeNoiseHandler,
	promiseTimeout
} from '../Utils'
import { getPlatformId } from '../Utils/browser-utils'
import {
	assertNodeErrorFree,
	type BinaryNode,
	binaryNodeToString,
	encodeBinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isLidUser,
	jidDecode,
	jidEncode,
	S_WHATSAPP_NET
} from '../WABinary'
import { BinaryInfo } from '../WAM/BinaryInfo.js'
import { USyncQuery, USyncUser } from '../WAUSync/'
import { WebSocketClient } from './Client'

/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */

export const makeSocket = (config: SocketConfig) => {
	const {
		waWebSocketUrl,
		connectTimeoutMs,
		logger,
		keepAliveIntervalMs,
		browser,
		auth: authState,
		printQRInTerminal,
		defaultQueryTimeoutMs,
		transactionOpts,
		qrTimeout,
		makeSignalRepository
	} = config

	const publicWAMBuffer = new BinaryInfo()

	const uqTagId = generateMdTagPrefix()
	const generateMessageTag = () => `${uqTagId}${epoch++}`

	if (printQRInTerminal) {
		console.warn(
			'⚠️ The printQRInTerminal option has been deprecated. You will no longer receive QR codes in the terminal automatically. Please listen to the connection.update event yourself and handle the QR your way. You can remove this message by removing this opttion. This message will be removed in a future version.'
		)
	}

	const url = typeof waWebSocketUrl === 'string' ? new URL(waWebSocketUrl) : waWebSocketUrl

	if (config.mobile || url.protocol === 'tcp:') {
		throw new Boom('Mobile API is not supported anymore', { statusCode: DisconnectReason.loggedOut })
	}

	if (url.protocol === 'wss' && authState?.creds?.routingInfo) {
		url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'))
	}

	/** ephemeral key pair used to encrypt/decrypt communication. Unique for each connection */
	const ephemeralKeyPair = Curve.generateKeyPair()
	/** WA noise protocol wrapper */
	const noise = makeNoiseHandler({
		keyPair: ephemeralKeyPair,
		NOISE_HEADER: NOISE_WA_HEADER,
		logger,
		routingInfo: authState?.creds?.routingInfo
	})

	const ws = new WebSocketClient(url, config)

	ws.connect()

	const sendPromise = promisify(ws.send)
	/** send a raw buffer */
	const sendRawMessage = async (data: Uint8Array | Buffer) => {
		if (!ws.isOpen) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		const bytes = noise.encodeFrame(data)
		await promiseTimeout<void>(connectTimeoutMs, async (resolve, reject) => {
			try {
				await sendPromise.call(ws, bytes)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	}

	/** send a binary node */
	const sendNode = (frame: BinaryNode) => {
		if (logger.level === 'trace') {
			logger.trace({ xml: binaryNodeToString(frame), msg: 'xml send' })
		}

		const buff = encodeBinaryNode(frame)
		return sendRawMessage(buff)
	}

	/**
	 * Wait for a message with a certain tag to be received
	 * @param msgId the message tag to await
	 * @param timeoutMs timeout after which the promise will reject
	 */
	const waitForMessage = async <T>(msgId: string, timeoutMs = defaultQueryTimeoutMs) => {
		let onRecv: ((data: T) => void) | undefined
		let onErr: ((err: Error) => void) | undefined
		try {
			const result = await promiseTimeout<T>(timeoutMs, (resolve, reject) => {
				onRecv = data => {
					resolve(data)
				}

				onErr = err => {
					reject(
						err ||
							new Boom('Connection Closed', {
								statusCode: DisconnectReason.connectionClosed
							})
					)
				}

				ws.on(`TAG:${msgId}`, onRecv)
				ws.on('close', onErr)
				ws.on('error', onErr)

				return () => reject(new Boom('Query Cancelled'))
			})
			return result
		} catch (error) {
			// Catch timeout and return undefined instead of throwing
			if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) {
				logger?.warn?.({ msgId }, 'timed out waiting for message')
				return undefined
			}

			throw error
		} finally {
			if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
			if (onErr) {
				ws.off('close', onErr)
				ws.off('error', onErr)
			}
		}
	}

	/** send a query, and wait for its response. auto-generates message ID if not provided */
	const query = async (node: BinaryNode, timeoutMs?: number) => {
		if (!node.attrs.id) {
			node.attrs.id = generateMessageTag()
		}

		const msgId = node.attrs.id

		const result = await promiseTimeout<any>(timeoutMs, async (resolve, reject) => {
			const result = waitForMessage(msgId, timeoutMs).catch(reject)
			sendNode(node)
				.then(async () => resolve(await result))
				.catch(reject)
		})

		if (result && 'tag' in result) {
			assertNodeErrorFree(result)
		}

		return result
	}

	const executeUSyncQuery = async (usyncQuery: USyncQuery) => {
		if (usyncQuery.protocols.length === 0) {
			throw new Boom('USyncQuery must have at least one protocol')
		}

		// todo: validate users, throw WARNING on no valid users
		// variable below has only validated users
		const validUsers = usyncQuery.users

		const userNodes = validUsers.map(user => {
			return {
				tag: 'user',
				attrs: {
					jid: !user.phone ? user.id : undefined
				},
				content: usyncQuery.protocols.map(a => a.getUserElement(user)).filter(a => a !== null)
			} as BinaryNode
		})

		const listNode: BinaryNode = {
			tag: 'list',
			attrs: {},
			content: userNodes
		}

		const queryNode: BinaryNode = {
			tag: 'query',
			attrs: {},
			content: usyncQuery.protocols.map(a => a.getQueryElement())
		}
		const iq = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'usync'
			},
			content: [
				{
					tag: 'usync',
					attrs: {
						context: usyncQuery.context,
						mode: usyncQuery.mode,
						sid: generateMessageTag(),
						last: 'true',
						index: '0'
					},
					content: [queryNode, listNode]
				}
			]
		}

		const result = await query(iq)

		return usyncQuery.parseUSyncQueryResult(result)
	}

	const onWhatsApp = async (...phoneNumber: string[]) => {
		let usyncQuery = new USyncQuery()

		let contactEnabled = false
		for (const jid of phoneNumber) {
			if (isLidUser(jid)) {
				logger?.warn('LIDs are not supported with onWhatsApp')
				continue
			} else {
				if (!contactEnabled) {
					contactEnabled = true
					usyncQuery = usyncQuery.withContactProtocol()
				}

				const phone = `+${jid.replace('+', '').split('@')[0]?.split(':')[0]}`
				usyncQuery.withUser(new USyncUser().withPhone(phone))
			}
		}

		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}

		const results = await executeUSyncQuery(usyncQuery)

		if (results) {
			return results.list.filter(a => !!a.contact).map(({ contact, id }) => ({ jid: id, exists: contact as boolean }))
		}
	}

	const pnFromLIDUSync = async (jids: string[]): Promise<LIDMapping[] | undefined> => {
		const usyncQuery = new USyncQuery().withLIDProtocol().withContext('background')

		for (const jid of jids) {
			if (isLidUser(jid)) {
				logger?.warn('LID user found in LID fetch call')
				continue
			} else {
				usyncQuery.withUser(new USyncUser().withId(jid))
			}
		}

		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}

		const results = await executeUSyncQuery(usyncQuery)

		if (results) {
			return results.list.filter(a => !!a.lid).map(({ lid, id }) => ({ pn: id, lid: lid as string }))
		}

		return []
	}

	const ev = makeEventBuffer(logger)

	const { creds } = authState
	// add transaction capability
	const keys = addTransactionCapability(authState.keys, logger, transactionOpts)
	const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync)

	let lastDateRecv: Date
	let epoch = 1
	let keepAliveReq: NodeJS.Timeout
	let qrTimer: NodeJS.Timeout
	let closed = false

	/** log & process any unexpected errors */
	const onUnexpectedError = (err: Error | Boom, msg: string) => {
		logger.error({ err }, `unexpected error in '${msg}'`)
	}

	/** await the next incoming message */
	const awaitNextMessage = async <T>(sendMsg?: Uint8Array) => {
		if (!ws.isOpen) {
			throw new Boom('Connection Closed', {
				statusCode: DisconnectReason.connectionClosed
			})
		}

		let onOpen: (data: T) => void
		let onClose: (err: Error) => void

		const result = promiseTimeout<T>(connectTimeoutMs, (resolve, reject) => {
			onOpen = resolve
			onClose = mapWebSocketError(reject)
			ws.on('frame', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('frame', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})

		if (sendMsg) {
			sendRawMessage(sendMsg).catch(onClose!)
		}

		return result
	}

	/** connection handshake */
	const validateConnection = async () => {
		let helloMsg: proto.IHandshakeMessage = {
			clientHello: { ephemeral: ephemeralKeyPair.public }
		}
		helloMsg = proto.HandshakeMessage.fromObject(helloMsg)

		logger.info({ browser, helloMsg }, 'connected to WA')

		const init = proto.HandshakeMessage.encode(helloMsg).finish()

		const result = await awaitNextMessage<Uint8Array>(init)
		const handshake = proto.HandshakeMessage.decode(result)

		logger.trace({ handshake }, 'handshake recv from WA')

		const keyEnc = await noise.processHandshake(handshake, creds.noiseKey)

		let node: proto.IClientPayload
		if (!creds.me) {
			node = generateRegistrationNode(creds, config)
			logger.info({ node }, 'not logged in, attempting registration...')
		} else {
			node = generateLoginNode(creds.me.id, config)
			logger.info({ node }, 'logging in...')
		}

		const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish())
		await sendRawMessage(
			proto.HandshakeMessage.encode({
				clientFinish: {
					static: keyEnc,
					payload: payloadEnc
				}
			}).finish()
		)
		noise.finishInit()
		startKeepAliveRequest()
	}

	const getAvailablePreKeysOnServer = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				id: generateMessageTag(),
				xmlns: 'encrypt',
				type: 'get',
				to: S_WHATSAPP_NET
			},
			content: [{ tag: 'count', attrs: {} }]
		})
		const countChild = getBinaryNodeChild(result, 'count')!
		return +countChild.attrs.value!
	}

	// Pre-key upload state management
	let uploadPreKeysPromise: Promise<void> | null = null
	let lastUploadTime = 0

	/** generates and uploads a set of pre-keys to the server */
	const uploadPreKeys = async (count = MIN_PREKEY_COUNT, retryCount = 0) => {
		// Check minimum interval (except for retries)
		if (retryCount === 0) {
			const timeSinceLastUpload = Date.now() - lastUploadTime
			if (timeSinceLastUpload < MIN_UPLOAD_INTERVAL) {
				logger.debug(`Skipping upload, only ${timeSinceLastUpload}ms since last upload`)
				return
			}
		}

		// Prevent multiple concurrent uploads
		if (uploadPreKeysPromise) {
			logger.debug('Pre-key upload already in progress, waiting for completion')
			await uploadPreKeysPromise
		}

		const uploadLogic = async () => {
			logger.info({ count, retryCount }, 'uploading pre-keys')

			// Generate and save pre-keys atomically (prevents ID collisions on retry)
			const node = await keys.transaction(async () => {
				logger.debug({ requestedCount: count }, 'generating pre-keys with requested count')
				const { update, node } = await getNextPreKeysNode({ creds, keys }, count)
				// Update credentials immediately to prevent duplicate IDs on retry
				ev.emit('creds.update', update)
				return node // Only return node since update is already used
			}, creds?.me?.id || 'upload-pre-keys')

			// Upload to server (outside transaction, can fail without affecting local keys)
			try {
				await query(node)
				logger.info({ count }, 'uploaded pre-keys successfully')
				lastUploadTime = Date.now()
			} catch (uploadError) {
				logger.error({ uploadError: (uploadError as Error).toString(), count }, 'Failed to upload pre-keys to server')

				// Exponential backoff retry (max 3 retries)
				if (retryCount < 3) {
					const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000)
					logger.info(`Retrying pre-key upload in ${backoffDelay}ms`)
					await new Promise(resolve => setTimeout(resolve, backoffDelay))
					return uploadPreKeys(count, retryCount + 1)
				}

				throw uploadError
			}
		}

		// Add timeout protection
		uploadPreKeysPromise = Promise.race([
			uploadLogic(),
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Boom('Pre-key upload timeout', { statusCode: 408 })), UPLOAD_TIMEOUT)
			)
		])

		try {
			await uploadPreKeysPromise
		} finally {
			uploadPreKeysPromise = null
		}
	}

	const verifyCurrentPreKeyExists = async () => {
		const currentPreKeyId = creds.nextPreKeyId - 1
		if (currentPreKeyId <= 0) {
			return { exists: false, currentPreKeyId: 0 }
		}

		const preKeys = await keys.get('pre-key', [currentPreKeyId.toString()])
		const exists = !!preKeys[currentPreKeyId.toString()]

		return { exists, currentPreKeyId }
	}

	const uploadPreKeysToServerIfRequired = async () => {
		try {
			let count = 0
			const preKeyCount = await getAvailablePreKeysOnServer()
			if (preKeyCount === 0) count = INITIAL_PREKEY_COUNT
			else count = MIN_PREKEY_COUNT
			const { exists: currentPreKeyExists, currentPreKeyId } = await verifyCurrentPreKeyExists()

			logger.info(`${preKeyCount} pre-keys found on server`)
			logger.info(`Current prekey ID: ${currentPreKeyId}, exists in storage: ${currentPreKeyExists}`)

			const lowServerCount = preKeyCount <= count
			const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0

			const shouldUpload = lowServerCount || missingCurrentPreKey

			if (shouldUpload) {
				const reasons = []
				if (lowServerCount) reasons.push(`server count low (${preKeyCount})`)
				if (missingCurrentPreKey) reasons.push(`current prekey ${currentPreKeyId} missing from storage`)

				logger.info(`Uploading PreKeys due to: ${reasons.join(', ')}`)
				await uploadPreKeys(count)
			} else {
				logger.info(`PreKey validation passed - Server: ${preKeyCount}, Current prekey ${currentPreKeyId} exists`)
			}
		} catch (error) {
			logger.error({ error }, 'Failed to check/upload pre-keys during initialization')
			// Don't throw - allow connection to continue even if pre-key check fails
		}
	}

	const onMessageReceived = (data: Buffer) => {
		noise.decodeFrame(data, frame => {
			// reset ping timeout
			lastDateRecv = new Date()

			let anyTriggered = false

			anyTriggered = ws.emit('frame', frame)
			// if it's a binary node
			if (!(frame instanceof Uint8Array)) {
				const msgId = frame.attrs.id

				if (logger.level === 'trace') {
					logger.trace({ xml: binaryNodeToString(frame), msg: 'recv xml' })
				}

				/* Check if this is a response to a message we sent */
				anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
				/* Check if this is a response to a message we are expecting */
				const l0 = frame.tag
				const l1 = frame.attrs || {}
				const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ''

				for (const key of Object.keys(l1)) {
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
				}

				anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
				anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered

				if (!anyTriggered && logger.level === 'debug') {
					logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv')
				}
			}
		})
	}

	const end = (error: Error | undefined) => {
		if (closed) {
			logger.trace({ trace: error?.stack }, 'connection already closed')
			return
		}

		closed = true
		logger.info({ trace: error?.stack }, error ? 'connection errored' : 'connection closed')

		clearInterval(keepAliveReq)
		clearTimeout(qrTimer)

		ws.removeAllListeners('close')
		ws.removeAllListeners('open')
		ws.removeAllListeners('message')

		if (!ws.isClosed && !ws.isClosing) {
			try {
				ws.close()
			} catch {}
		}

		ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: {
				error,
				date: new Date()
			}
		})
		ev.removeAllListeners('connection.update')
	}

	const waitForSocketOpen = async () => {
		if (ws.isOpen) {
			return
		}

		if (ws.isClosed || ws.isClosing) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		let onOpen: () => void
		let onClose: (err: Error) => void
		await new Promise((resolve, reject) => {
			onOpen = () => resolve(undefined)
			onClose = mapWebSocketError(reject)
			ws.on('open', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('open', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})
	}

	const startKeepAliveRequest = () =>
		(keepAliveReq = setInterval(() => {
			if (!lastDateRecv) {
				lastDateRecv = new Date()
			}

			const diff = Date.now() - lastDateRecv.getTime()
			/*
				check if it's been a suspicious amount of time since the server responded with our last seen
				it could be that the network is down
			*/
			if (diff > keepAliveIntervalMs + 5000) {
				end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }))
			} else if (ws.isOpen) {
				// if its all good, send a keep alive request
				query({
					tag: 'iq',
					attrs: {
						id: generateMessageTag(),
						to: S_WHATSAPP_NET,
						type: 'get',
						xmlns: 'w:p'
					},
					content: [{ tag: 'ping', attrs: {} }]
				}).catch(err => {
					logger.error({ trace: err.stack }, 'error in sending keep alive')
				})
			} else {
				logger.warn('keep alive called when WS not open')
			}
		}, keepAliveIntervalMs))
	/** i have no idea why this exists. pls enlighten me */
	const sendPassiveIq = (tag: 'passive' | 'active') =>
		query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'passive',
				type: 'set'
			},
			content: [{ tag, attrs: {} }]
		})

	/** logout & invalidate connection */
	const logout = async (msg?: string) => {
		const jid = authState.creds.me?.id
		if (jid) {
			await sendNode({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					id: generateMessageTag(),
					xmlns: 'md'
				},
				content: [
					{
						tag: 'remove-companion-device',
						attrs: {
							jid,
							reason: 'user_initiated'
						}
					}
				]
			})
		}

		end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }))
	}

	const requestPairingCode = async (phoneNumber: string, customPairingCode?: string): Promise<string> => {
		const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5))

		if (customPairingCode && customPairingCode?.length !== 8) {
			throw new Error('Custom pairing code must be exactly 8 chars')
		}

		authState.creds.pairingCode = pairingCode

		authState.creds.me = {
			id: jidEncode(phoneNumber, 's.whatsapp.net'),
			name: '~'
		}
		ev.emit('creds.update', authState.creds)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				id: generateMessageTag(),
				xmlns: 'md'
			},
			content: [
				{
					tag: 'link_code_companion_reg',
					attrs: {
						jid: authState.creds.me.id,
						stage: 'companion_hello',

						should_show_push_notification: 'true'
					},
					content: [
						{
							tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
							attrs: {},
							content: await generatePairingKey()
						},
						{
							tag: 'companion_server_auth_key_pub',
							attrs: {},
							content: authState.creds.noiseKey.public
						},
						{
							tag: 'companion_platform_id',
							attrs: {},
							content: getPlatformId(browser[1])
						},
						{
							tag: 'companion_platform_display',
							attrs: {},
							content: `${browser[1]} (${browser[0]})`
						},
						{
							tag: 'link_code_pairing_nonce',
							attrs: {},
							content: '0'
						}
					]
				}
			]
		})
		return authState.creds.pairingCode
	}

	async function generatePairingKey() {
		const salt = randomBytes(32)
		const randomIv = randomBytes(16)
		const key = await derivePairingCodeKey(authState.creds.pairingCode!, salt)
		const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv)
		return Buffer.concat([salt, randomIv, ciphered])
	}

	const sendWAMBuffer = (wamBuffer: Buffer) => {
		return query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				id: generateMessageTag(),
				xmlns: 'w:stats'
			},
			content: [
				{
					tag: 'add',
					attrs: { t: Math.round(Date.now() / 1000) + '' },
					content: wamBuffer
				}
			]
		})
	}

	ws.on('message', onMessageReceived)

	ws.on('open', async () => {
		try {
			await validateConnection()
		} catch (err: any) {
			logger.error({ err }, 'error in validating connection')
			end(err)
		}
	})
	ws.on('error', mapWebSocketError(end))
	ws.on('close', () => end(new Boom('Connection Terminated', { statusCode: DisconnectReason.connectionClosed })))
	// the server terminated the connection
	ws.on('CB:xmlstreamend', () =>
		end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed }))
	)
	// QR gen
	ws.on('CB:iq,type:set,pair-device', async (stanza: BinaryNode) => {
		const iq: BinaryNode = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'result',
				id: stanza.attrs.id!
			}
		}
		await sendNode(iq)

		const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device')
		const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref')
		const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64')
		const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64')
		const advB64 = creds.advSecretKey

		let qrMs = qrTimeout || 60_000 // time to let a QR live
		const genPairQR = () => {
			if (!ws.isOpen) {
				return
			}

			const refNode = refNodes.shift()
			if (!refNode) {
				end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }))
				return
			}

			const ref = (refNode.content as Buffer).toString('utf-8')
			const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',')

			ev.emit('connection.update', { qr })

			qrTimer = setTimeout(genPairQR, qrMs)
			qrMs = qrTimeout || 20_000 // shorter subsequent qrs
		}

		genPairQR()
	})
	// device paired for the first time
	// if device pairs successfully, the server asks to restart the connection
	ws.on('CB:iq,,pair-success', async (stanza: BinaryNode) => {
		logger.debug('pair success recv')
		try {
			const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)

			logger.info(
				{ me: updatedCreds.me, platform: updatedCreds.platform },
				'pairing configured successfully, expect to restart the connection...'
			)

			ev.emit('creds.update', updatedCreds)
			ev.emit('connection.update', { isNewLogin: true, qr: undefined })

			await sendNode(reply)
		} catch (error: any) {
			logger.info({ trace: error.stack }, 'error in pairing')
			end(error)
		}
	})
	// login complete
	ws.on('CB:success', async (node: BinaryNode) => {
		try {
			await uploadPreKeysToServerIfRequired()
			await sendPassiveIq('active')
		} catch (err) {
			logger.warn({ err }, 'failed to send initial passive iq')
		}

		logger.info('opened connection to WA')
		clearTimeout(qrTimer) // will never happen in all likelyhood -- but just in case WA sends success on first try

		ev.emit('creds.update', { me: { ...authState.creds.me!, lid: node.attrs.lid } })

		ev.emit('connection.update', { connection: 'open' })

		if (node.attrs.lid && authState.creds.me?.id) {
			const myLID = node.attrs.lid
			process.nextTick(async () => {
				try {
					const myPN = authState.creds.me!.id

					// Store our own LID-PN mapping
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])

					// Create device list for our own user (needed for bulk migration)
					const { user, device } = jidDecode(myPN)!
					await authState.keys.set({
						'device-list': {
							[user]: [device?.toString() || '0']
						}
					})

					// migrate our own session
					await signalRepository.migrateSession(myPN, myLID)

					logger.info({ myPN, myLID }, 'Own LID session created successfully')
				} catch (error) {
					logger.error({ error, lid: myLID }, 'Failed to create own LID session')
				}
			})
		}
	})

	ws.on('CB:stream:error', (node: BinaryNode) => {
		logger.error({ node }, 'stream errored out')

		const { reason, statusCode } = getErrorCodeFromStreamError(node)

		end(new Boom(`Stream Errored (${reason})`, { statusCode, data: node }))
	})
	// stream fail, possible logout
	ws.on('CB:failure', (node: BinaryNode) => {
		const reason = +(node.attrs.reason || 500)
		end(new Boom('Connection Failure', { statusCode: reason, data: node.attrs }))
	})

	ws.on('CB:ib,,downgrade_webclient', () => {
		end(new Boom('Multi-device beta not joined', { statusCode: DisconnectReason.multideviceMismatch }))
	})

	ws.on('CB:ib,,offline_preview', (node: BinaryNode) => {
		logger.info('offline preview received', JSON.stringify(node))
		sendNode({
			tag: 'ib',
			attrs: {},
			content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
		})
	})

	ws.on('CB:ib,,edge_routing', (node: BinaryNode) => {
		const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing')
		const routingInfo = getBinaryNodeChild(edgeRoutingNode, 'routing_info')
		if (routingInfo?.content) {
			authState.creds.routingInfo = Buffer.from(routingInfo?.content as Uint8Array)
			ev.emit('creds.update', authState.creds)
		}
	})

	let didStartBuffer = false
	process.nextTick(() => {
		if (creds.me?.id) {
			// start buffering important events
			// if we're logged in
			ev.buffer()
			didStartBuffer = true
		}

		ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })
	})

	// called when all offline notifs are handled
	ws.on('CB:ib,,offline', (node: BinaryNode) => {
		const child = getBinaryNodeChild(node, 'offline')
		const offlineNotifs = +(child?.attrs.count || 0)

		logger.info(`handled ${offlineNotifs} offline messages/notifications`)
		if (didStartBuffer) {
			ev.flush()
			logger.trace('flushed events for initial buffer')
		}

		ev.emit('connection.update', { receivedPendingNotifications: true })
	})

	// update credentials when required
	ev.on('creds.update', update => {
		const name = update.me?.name
		// if name has just been received
		if (creds.me?.name !== name) {
			logger.debug({ name }, 'updated pushName')
			sendNode({
				tag: 'presence',
				attrs: { name: name! }
			}).catch(err => {
				logger.warn({ trace: err.stack }, 'error in sending presence update on name change')
			})
		}

		Object.assign(creds, update)
	})

	return {
		type: 'md' as 'md',
		ws,
		ev,
		authState: { creds, keys },
		signalRepository,
		get user() {
			return authState.creds.me
		},
		generateMessageTag,
		query,
		waitForMessage,
		waitForSocketOpen,
		sendRawMessage,
		sendNode,
		logout,
		end,
		onUnexpectedError,
		uploadPreKeys,
		uploadPreKeysToServerIfRequired,
		requestPairingCode,
		wamBuffer: publicWAMBuffer,
		/** Waits for the connection to WA to reach a state */
		waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
		sendWAMBuffer,
		executeUSyncQuery,
		onWhatsApp
	}
}

/**
 * map the websocket error to the right type
 * so it can be retried by the caller
 * */
function mapWebSocketError(handler: (err: Error) => void) {
	return (error: Error) => {
		handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: getCodeFromWSError(error), data: error }))
	}
}



================================================
FILE: src/Socket/Client/index.ts
================================================
export * from './types'
export * from './websocket'



================================================
FILE: src/Socket/Client/types.ts
================================================
import { EventEmitter } from 'events'
import { URL } from 'url'
import type { SocketConfig } from '../../Types'

export abstract class AbstractSocketClient extends EventEmitter {
	abstract get isOpen(): boolean
	abstract get isClosed(): boolean
	abstract get isClosing(): boolean
	abstract get isConnecting(): boolean

	constructor(
		public url: URL,
		public config: SocketConfig
	) {
		super()
		this.setMaxListeners(0)
	}

	abstract connect(): Promise<void>
	abstract close(): Promise<void>
	abstract send(str: Uint8Array | string, cb?: (err?: Error) => void): boolean
}



================================================
FILE: src/Socket/Client/websocket.ts
================================================
import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}
	get isConnecting(): boolean {
		return this.socket?.readyState === WebSocket.CONNECTING
	}

	async connect(): Promise<void> {
		if (this.socket) {
			return
		}

		this.socket = new WebSocket(this.url, {
			origin: DEFAULT_ORIGIN,
			headers: this.config.options?.headers as {},
			handshakeTimeout: this.config.connectTimeoutMs,
			timeout: this.config.connectTimeoutMs,
			agent: this.config.agent
		})

		this.socket.setMaxListeners(0)

		const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']

		for (const event of events) {
			this.socket?.on(event, (...args: any[]) => this.emit(event, ...args))
		}
	}

	async close(): Promise<void> {
		if (!this.socket) {
			return
		}

		this.socket.close()
		this.socket = null
	}
	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		this.socket?.send(str, cb)

		return Boolean(this.socket)
	}
}



================================================
FILE: src/Types/Auth.ts
================================================
import type { proto } from '../../WAProto/index.js'
import type { Contact } from './Contact'
import type { MinimalMessage } from './Message'

export type KeyPair = { public: Uint8Array; private: Uint8Array }
export type SignedKeyPair = {
	keyPair: KeyPair
	signature: Uint8Array
	keyId: number
	timestampS?: number
}

export type ProtocolAddress = {
	name: string // jid
	deviceId: number
}
export type SignalIdentity = {
	identifier: ProtocolAddress
	identifierKey: Uint8Array
}

export type LIDMapping = {
	pn: string
	lid: string
}

export type LTHashState = {
	version: number
	hash: Buffer
	indexValueMap: {
		[indexMacBase64: string]: { valueMac: Uint8Array | Buffer }
	}
}

export type SignalCreds = {
	readonly signedIdentityKey: KeyPair
	readonly signedPreKey: SignedKeyPair
	readonly registrationId: number
}

export type AccountSettings = {
	/** unarchive chats when a new message is received */
	unarchiveChats: boolean
	/** the default mode to start new conversations with */
	defaultDisappearingMode?: Pick<proto.IConversation, 'ephemeralExpiration' | 'ephemeralSettingTimestamp'>
}

export type AuthenticationCreds = SignalCreds & {
	readonly noiseKey: KeyPair
	readonly pairingEphemeralKeyPair: KeyPair
	advSecretKey: string

	me?: Contact
	account?: proto.IADVSignedDeviceIdentity
	signalIdentities?: SignalIdentity[]
	myAppStateKeyId?: string
	firstUnuploadedPreKeyId: number
	nextPreKeyId: number

	lastAccountSyncTimestamp?: number
	platform?: string

	processedHistoryMessages: MinimalMessage[]
	/** number of times history & app state has been synced */
	accountSyncCounter: number
	accountSettings: AccountSettings
	registered: boolean
	pairingCode: string | undefined
	lastPropHash: string | undefined
	routingInfo: Buffer | undefined
	additionalData?: any | undefined
}

export type SignalDataTypeMap = {
	'pre-key': KeyPair
	session: Uint8Array
	'sender-key': Uint8Array
	'sender-key-memory': { [jid: string]: boolean }
	'app-state-sync-key': proto.Message.IAppStateSyncKeyData
	'app-state-sync-version': LTHashState
	'lid-mapping': string
	'device-list': string[]
}

export type SignalDataSet = { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }

type Awaitable<T> = T | Promise<T>

export type SignalKeyStore = {
	get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Awaitable<{ [id: string]: SignalDataTypeMap[T] }>
	set(data: SignalDataSet): Awaitable<void>
	/** clear all the data in the store */
	clear?(): Awaitable<void>
}

export type SignalKeyStoreWithTransaction = SignalKeyStore & {
	isInTransaction: () => boolean
	transaction<T>(exec: () => Promise<T>, key: string): Promise<T>
}

export type TransactionCapabilityOptions = {
	maxCommitRetries: number
	delayBetweenTriesMs: number
}

export type SignalAuthState = {
	creds: SignalCreds
	keys: SignalKeyStore | SignalKeyStoreWithTransaction
}

export type AuthenticationState = {
	creds: AuthenticationCreds
	keys: SignalKeyStore
}



================================================
FILE: src/Types/Bussines.ts
================================================
import type { proto } from '../../WAProto'

export type DayOfWeekBussines = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'

export type HoursDay =
	| { day: DayOfWeekBussines; mode: 'specific_hours'; openTimeInMinutes: string; closeTimeInMinutes: string }
	| { day: DayOfWeekBussines; mode: 'open_24h' | 'appointment_only' }

export type UpdateBussinesProfileProps = {
	address?: string
	websites?: string[]
	email?: string
	description?: string
	hours?: {
		timezone: string
		days: HoursDay[]
	}
}

export type QuickReplyAction = proto.SyncActionValue.IQuickReplyAction & { timestamp?: string }



================================================
FILE: src/Types/Call.ts
================================================
export type WACallUpdateType = 'offer' | 'ringing' | 'timeout' | 'reject' | 'accept' | 'terminate'

export type WACallEvent = {
	chatId: string
	from: string
	isGroup?: boolean
	groupJid?: string
	id: string
	date: Date
	isVideo?: boolean
	status: WACallUpdateType
	offline: boolean
	latencyMs?: number
}



================================================
FILE: src/Types/Chat.ts
================================================
import type { proto } from '../../WAProto/index.js'
import type { AccountSettings } from './Auth'
import type { QuickReplyAction } from './Bussines.js'
import type { BufferedEventData } from './Events'
import type { LabelActionBody } from './Label'
import type { ChatLabelAssociationActionBody } from './LabelAssociation'
import type { MessageLabelAssociationActionBody } from './LabelAssociation'
import type { MinimalMessage, WAMessageKey } from './Message'

/** privacy settings in WhatsApp Web */
export type WAPrivacyValue = 'all' | 'contacts' | 'contact_blacklist' | 'none'

export type WAPrivacyOnlineValue = 'all' | 'match_last_seen'

export type WAPrivacyGroupAddValue = 'all' | 'contacts' | 'contact_blacklist'

export type WAReadReceiptsValue = 'all' | 'none'

export type WAPrivacyCallValue = 'all' | 'known'

export type WAPrivacyMessagesValue = 'all' | 'contacts'

/** set of statuses visible to other people; see updatePresence() in WhatsAppWeb.Send */
export type WAPresence = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused'

export const ALL_WA_PATCH_NAMES = [
	'critical_block',
	'critical_unblock_low',
	'regular_high',
	'regular_low',
	'regular'
] as const

export type WAPatchName = (typeof ALL_WA_PATCH_NAMES)[number]

export interface PresenceData {
	lastKnownPresence: WAPresence
	lastSeen?: number
}

export type BotListInfo = {
	jid: string
	personaId: string
}

export type ChatMutation = {
	syncAction: proto.ISyncActionData
	index: string[]
}

export type WAPatchCreate = {
	syncAction: proto.ISyncActionValue
	index: string[]
	type: WAPatchName
	apiVersion: number
	operation: proto.SyncdMutation.SyncdOperation
}

export type Chat = proto.IConversation & {
	/** unix timestamp of when the last message was received in the chat */
	lastMessageRecvTimestamp?: number
}

export type ChatUpdate = Partial<
	Chat & {
		/**
		 * if specified in the update,
		 * the EV buffer will check if the condition gets fulfilled before applying the update
		 * Right now, used to determine when to release an app state sync event
		 *
		 * @returns true, if the update should be applied;
		 * false if it can be discarded;
		 * undefined if the condition is not yet fulfilled
		 * */
		conditional: (bufferedData: BufferedEventData) => boolean | undefined
		/** last update time */
		timestamp?: number
	}
>

/**
 * the last messages in a chat, sorted reverse-chronologically. That is, the latest message should be first in the chat
 * for MD modifications, the last message in the array (i.e. the earlist message) must be the last message recv in the chat
 * */
export type LastMessageList = MinimalMessage[] | proto.SyncActionValue.ISyncActionMessageRange

export type ChatModification =
	| {
			archive: boolean
			lastMessages: LastMessageList
	  }
	| { pushNameSetting: string }
	| { pin: boolean }
	| {
			/** mute for duration, or provide timestamp of mute to remove*/
			mute: number | null
	  }
	| {
			clear: boolean
			lastMessages: LastMessageList
	  }
	| {
			deleteForMe: { deleteMedia: boolean; key: WAMessageKey; timestamp: number }
	  }
	| {
			star: {
				messages: { id: string; fromMe?: boolean }[]
				star: boolean
			}
	  }
	| {
			markRead: boolean
			lastMessages: LastMessageList
	  }
	| { delete: true; lastMessages: LastMessageList }
	| { contact: proto.SyncActionValue.IContactAction | null }
	| { disableLinkPreviews: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction }
	// Label
	| { addLabel: LabelActionBody }
	// Label assosiation
	| { addChatLabel: ChatLabelAssociationActionBody }
	| { removeChatLabel: ChatLabelAssociationActionBody }
	| { addMessageLabel: MessageLabelAssociationActionBody }
	| { removeMessageLabel: MessageLabelAssociationActionBody }
	| { quickReply: QuickReplyAction }

export type InitialReceivedChatsState = {
	[jid: string]: {
		/** the last message received from the other party */
		lastMsgRecvTimestamp?: number
		/** the absolute last message in the chat */
		lastMsgTimestamp: number
	}
}

export type InitialAppStateSyncOptions = {
	accountSettings: AccountSettings
}



================================================
FILE: src/Types/Contact.ts
================================================
export interface Contact {
	/** ID either in lid or jid format (preferred) **/
	id: string
	/** ID in LID format (@lid) **/
	lid?: string
	/** ID in PN format (@s.whatsapp.net)  **/
	phoneNumber?: string
	/** name of the contact, you have saved on your WA */
	name?: string
	/** name of the contact, the contact has set on their own on WA */
	notify?: string
	/** I have no idea */
	verifiedName?: string
	// Baileys Added
	/**
	 * Url of the profile picture of the contact
	 *
	 * 'changed' => if the profile picture has changed
	 * null => if the profile picture has not been set (default profile picture)
	 * any other string => url of the profile picture
	 */
	imgUrl?: string | null
	status?: string
}



================================================
FILE: src/Types/Events.ts
================================================
import type { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds } from './Auth'
import type { WACallEvent } from './Call'
import type { Chat, ChatUpdate, PresenceData } from './Chat'
import type { Contact } from './Contact'
import type {
	GroupMetadata,
	GroupParticipant,
	ParticipantAction,
	RequestJoinAction,
	RequestJoinMethod
} from './GroupMetadata'
import type { Label } from './Label'
import type { LabelAssociation } from './LabelAssociation'
import type { MessageUpsertType, MessageUserReceiptUpdate, WAMessage, WAMessageKey, WAMessageUpdate } from './Message'
import type { ConnectionState } from './State'

// TODO: refactor this mess
export type BaileysEventMap = {
	/** connection state has been updated -- WS closed, opened, connecting etc. */
	'connection.update': Partial<ConnectionState>
	/** credentials updated -- some metadata, keys or something */
	'creds.update': Partial<AuthenticationCreds>
	/** set chats (history sync), everything is reverse chronologically sorted */
	'messaging-history.set': {
		chats: Chat[]
		contacts: Contact[]
		messages: WAMessage[]
		isLatest?: boolean
		progress?: number | null
		syncType?: proto.HistorySync.HistorySyncType | null
		peerDataRequestSessionId?: string | null
	}
	/** upsert chats */
	'chats.upsert': Chat[]
	/** update the given chats */
	'chats.update': ChatUpdate[]
	'lid-mapping.update': { lid: string; pn: string }
	/** delete chats with given ID */
	'chats.delete': string[]
	/** presence of contact in a chat updated */
	'presence.update': { id: string; presences: { [participant: string]: PresenceData } }

	'contacts.upsert': Contact[]
	'contacts.update': Partial<Contact>[]

	'messages.delete': { keys: WAMessageKey[] } | { jid: string; all: true }
	'messages.update': WAMessageUpdate[]
	'messages.media-update': { key: WAMessageKey; media?: { ciphertext: Uint8Array; iv: Uint8Array }; error?: Boom }[]
	/**
	 * add/update the given messages. If they were received while the connection was online,
	 * the update will have type: "notify"
	 * if requestId is provided, then the messages was received from the phone due to it being unavailable
	 *  */
	'messages.upsert': { messages: WAMessage[]; type: MessageUpsertType; requestId?: string }
	/** message was reacted to. If reaction was removed -- then "reaction.text" will be falsey */
	'messages.reaction': { key: WAMessageKey; reaction: proto.IReaction }[]

	'message-receipt.update': MessageUserReceiptUpdate[]

	'groups.upsert': GroupMetadata[]
	'groups.update': Partial<GroupMetadata>[]
	/** apply an action to participants in a group */
	'group-participants.update': {
		id: string
		author: string
		authorPn?: string
		participants: GroupParticipant[]
		action: ParticipantAction
	}
	'group.join-request': {
		id: string
		author: string
		authorPn?: string
		participant: string
		participantPn?: string
		action: RequestJoinAction
		method: RequestJoinMethod
	}

	'blocklist.set': { blocklist: string[] }
	'blocklist.update': { blocklist: string[]; type: 'add' | 'remove' }

	/** Receive an update on a call, including when the call was received, rejected, accepted */
	call: WACallEvent[]
	'labels.edit': Label
	'labels.association': { association: LabelAssociation; type: 'add' | 'remove' }

	/** Newsletter-related events */
	'newsletter.reaction': {
		id: string
		server_id: string
		reaction: { code?: string; count?: number; removed?: boolean }
	}
	'newsletter.view': { id: string; server_id: string; count: number }
	'newsletter-participants.update': { id: string; author: string; user: string; new_role: string; action: string }
	'newsletter-settings.update': { id: string; update: any }
}

export type BufferedEventData = {
	historySets: {
		chats: { [jid: string]: Chat }
		contacts: { [jid: string]: Contact }
		messages: { [uqId: string]: WAMessage }
		empty: boolean
		isLatest: boolean
		progress?: number | null
		syncType?: proto.HistorySync.HistorySyncType
		peerDataRequestSessionId?: string
	}
	chatUpserts: { [jid: string]: Chat }
	chatUpdates: { [jid: string]: ChatUpdate }
	chatDeletes: Set<string>
	contactUpserts: { [jid: string]: Contact }
	contactUpdates: { [jid: string]: Partial<Contact> }
	messageUpserts: { [key: string]: { type: MessageUpsertType; message: WAMessage } }
	messageUpdates: { [key: string]: WAMessageUpdate }
	messageDeletes: { [key: string]: WAMessageKey }
	messageReactions: { [key: string]: { key: WAMessageKey; reactions: proto.IReaction[] } }
	messageReceipts: { [key: string]: { key: WAMessageKey; userReceipt: proto.IUserReceipt[] } }
	groupUpdates: { [jid: string]: Partial<GroupMetadata> }
}

export type BaileysEvent = keyof BaileysEventMap

export interface BaileysEventEmitter {
	on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void
	off<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void
	removeAllListeners<T extends keyof BaileysEventMap>(event: T): void
	emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): boolean
}



================================================
FILE: src/Types/globals.d.ts
================================================
declare global {
	interface RequestInit {
		dispatcher?: any
		duplex?: 'half' | 'full'
	}
}

export {}



================================================
FILE: src/Types/GroupMetadata.ts
================================================
import type { Contact } from './Contact'
import type { WAMessageAddressingMode } from './Message'

export type GroupParticipant = Contact & {
	isAdmin?: boolean
	isSuperAdmin?: boolean
	admin?: 'admin' | 'superadmin' | null
}

export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'modify'

export type RequestJoinAction = 'created' | 'revoked' | 'rejected'

export type RequestJoinMethod = 'invite_link' | 'linked_group_join' | 'non_admin_add' | undefined

export interface GroupMetadata {
	id: string
	notify?: string
	/** group uses 'lid' or 'pn' to send messages */
	addressingMode?: WAMessageAddressingMode
	owner: string | undefined
	ownerPn?: string | undefined
	owner_country_code?: string | undefined
	subject: string
	/** group subject owner */
	subjectOwner?: string
	subjectOwnerPn?: string
	/** group subject modification date */
	subjectTime?: number
	creation?: number
	desc?: string
	descOwner?: string
	descOwnerPn?: string
	descId?: string
	descTime?: number
	/** if this group is part of a community, it returns the jid of the community to which it belongs */
	linkedParent?: string
	/** is set when the group only allows admins to change group settings */
	restrict?: boolean
	/** is set when the group only allows admins to write messages */
	announce?: boolean
	/** is set when the group also allows members to add participants */
	memberAddMode?: boolean
	/** Request approval to join the group */
	joinApprovalMode?: boolean
	/** is this a community */
	isCommunity?: boolean
	/** is this the announce of a community */
	isCommunityAnnounce?: boolean
	/** number of group participants */
	size?: number
	// Baileys modified array
	participants: GroupParticipant[]
	ephemeralDuration?: number
	inviteCode?: string
	/** the person who added you to group or changed some setting in group */
	author?: string
	authorPn?: string
}

export interface WAGroupCreateResponse {
	status: number
	gid?: string
	participants?: [{ [key: string]: {} }]
}

export interface GroupModificationResponse {
	status: number
	participants?: { [key: string]: {} }
}



================================================
FILE: src/Types/index.ts
================================================
export * from './Auth'
export * from './GroupMetadata'
export * from './Chat'
export * from './Contact'
export * from './State'
export * from './Message'
export * from './Socket'
export * from './Events'
export * from './Product'
export * from './Call'
export * from './Signal'
export * from './Newsletter'

import type { AuthenticationState } from './Auth'
import type { SocketConfig } from './Socket'

export type UserFacingSocketConfig = Partial<SocketConfig> & { auth: AuthenticationState }

export type BrowsersMap = {
	ubuntu(browser: string): [string, string, string]
	macOS(browser: string): [string, string, string]
	baileys(browser: string): [string, string, string]
	windows(browser: string): [string, string, string]
	appropriate(browser: string): [string, string, string]
}

export enum DisconnectReason {
	connectionClosed = 428,
	connectionLost = 408,
	connectionReplaced = 440,
	timedOut = 408,
	loggedOut = 401,
	badSession = 500,
	restartRequired = 515,
	multideviceMismatch = 411,
	forbidden = 403,
	unavailableService = 503
}

export type WAInitResponse = {
	ref: string
	ttl: number
	status: 200
}

export type WABusinessHoursConfig = {
	day_of_week: string
	mode: string
	open_time?: number
	close_time?: number
}

export type WABusinessProfile = {
	description: string
	email: string | undefined
	business_hours: {
		timezone?: string
		config?: WABusinessHoursConfig[]
		business_config?: WABusinessHoursConfig[]
	}
	website: string[]
	category?: string
	wid?: string
	address?: string
}

export type CurveKeyPair = { private: Uint8Array; public: Uint8Array }



================================================
FILE: src/Types/Label.ts
================================================
export interface Label {
	/** Label uniq ID */
	id: string
	/** Label name */
	name: string
	/** Label color ID */
	color: number
	/** Is label has been deleted */
	deleted: boolean
	/** WhatsApp has 5 predefined labels (New customer, New order & etc) */
	predefinedId?: string
}

export interface LabelActionBody {
	id: string
	/** Label name */
	name?: string
	/** Label color ID */
	color?: number
	/** Is label has been deleted */
	deleted?: boolean
	/** WhatsApp has 5 predefined labels (New customer, New order & etc) */
	predefinedId?: number
}

/** WhatsApp has 20 predefined colors */
export enum LabelColor {
	Color1 = 0,
	Color2,
	Color3,
	Color4,
	Color5,
	Color6,
	Color7,
	Color8,
	Color9,
	Color10,
	Color11,
	Color12,
	Color13,
	Color14,
	Color15,
	Color16,
	Color17,
	Color18,
	Color19,
	Color20
}



================================================
FILE: src/Types/LabelAssociation.ts
================================================
/** Association type */
export enum LabelAssociationType {
	Chat = 'label_jid',
	Message = 'label_message'
}

export type LabelAssociationTypes = `${LabelAssociationType}`

/** Association for chat */
export interface ChatLabelAssociation {
	type: LabelAssociationType.Chat
	chatId: string
	labelId: string
}

/** Association for message */
export interface MessageLabelAssociation {
	type: LabelAssociationType.Message
	chatId: string
	messageId: string
	labelId: string
}

export type LabelAssociation = ChatLabelAssociation | MessageLabelAssociation

/** Body for add/remove chat label association action */
export interface ChatLabelAssociationActionBody {
	labelId: string
}

/** body for add/remove message label association action */
export interface MessageLabelAssociationActionBody {
	labelId: string
	messageId: string
}



================================================
FILE: src/Types/Message.ts
================================================
import type { Readable } from 'stream'
import type { URL } from 'url'
import { proto } from '../../WAProto/index.js'
import type { MediaType } from '../Defaults'
import type { BinaryNode } from '../WABinary'
import type { GroupMetadata } from './GroupMetadata'
import type { CacheStore } from './Socket'

// export the WAMessage Prototypes
export { proto as WAProto }
export type WAMessage = proto.IWebMessageInfo & { key: WAMessageKey; messageStubParameters?: any }
export type WAMessageContent = proto.IMessage
export type WAContactMessage = proto.Message.IContactMessage
export type WAContactsArrayMessage = proto.Message.IContactsArrayMessage
export type WAMessageKey = proto.IMessageKey & {
	remoteJidAlt?: string
	participantAlt?: string
	server_id?: string
	addressingMode?: string
	isViewOnce?: boolean // TODO: remove out of the message key, place in WebMessageInfo
}
export type WATextMessage = proto.Message.IExtendedTextMessage
export type WAContextInfo = proto.IContextInfo
export type WALocationMessage = proto.Message.ILocationMessage
export type WAGenericMediaMessage =
	| proto.Message.IVideoMessage
	| proto.Message.IImageMessage
	| proto.Message.IAudioMessage
	| proto.Message.IDocumentMessage
	| proto.Message.IStickerMessage
export const WAMessageStubType = proto.WebMessageInfo.StubType
export const WAMessageStatus = proto.WebMessageInfo.Status
import type { ILogger } from '../Utils/logger'
export type WAMediaPayloadURL = { url: URL | string }
export type WAMediaPayloadStream = { stream: Readable }
export type WAMediaUpload = Buffer | WAMediaPayloadStream | WAMediaPayloadURL
/** Set of message types that are supported by the library */
export type MessageType = keyof proto.Message

export enum WAMessageAddressingMode {
	PN = 'pn',
	LID = 'lid'
}

export type MessageWithContextInfo =
	| 'imageMessage'
	| 'contactMessage'
	| 'locationMessage'
	| 'extendedTextMessage'
	| 'documentMessage'
	| 'audioMessage'
	| 'videoMessage'
	| 'call'
	| 'contactsArrayMessage'
	| 'liveLocationMessage'
	| 'templateMessage'
	| 'stickerMessage'
	| 'groupInviteMessage'
	| 'templateButtonReplyMessage'
	| 'productMessage'
	| 'listMessage'
	| 'orderMessage'
	| 'listResponseMessage'
	| 'buttonsMessage'
	| 'buttonsResponseMessage'
	| 'interactiveMessage'
	| 'interactiveResponseMessage'
	| 'pollCreationMessage'
	| 'requestPhoneNumberMessage'
	| 'messageHistoryBundle'
	| 'eventMessage'
	| 'newsletterAdminInviteMessage'
	| 'albumMessage'
	| 'stickerPackMessage'
	| 'pollResultSnapshotMessage'
	| 'messageHistoryNotice'

export type DownloadableMessage = { mediaKey?: Uint8Array | null; directPath?: string | null; url?: string | null }

export type MessageReceiptType =
	| 'read'
	| 'read-self'
	| 'hist_sync'
	| 'peer_msg'
	| 'sender'
	| 'inactive'
	| 'played'
	| undefined

export type MediaConnInfo = {
	auth: string
	ttl: number
	hosts: { hostname: string; maxContentLengthBytes: number }[]
	fetchDate: Date
}

export interface WAUrlInfo {
	'canonical-url': string
	'matched-text': string
	title: string
	description?: string
	jpegThumbnail?: Buffer
	highQualityThumbnail?: proto.Message.IImageMessage
	originalThumbnailUrl?: string
}

// types to generate WA messages
type Mentionable = {
	/** list of jids that are mentioned in the accompanying text */
	mentions?: string[]
}
type Contextable = {
	/** add contextInfo to the message */
	contextInfo?: proto.IContextInfo
}
type ViewOnce = {
	viewOnce?: boolean
}

type Editable = {
	edit?: WAMessageKey
}
type WithDimensions = {
	width?: number
	height?: number
}

export type PollMessageOptions = {
	name: string
	selectableCount?: number
	values: string[]
	/** 32 byte message secret to encrypt poll selections */
	messageSecret?: Uint8Array
	toAnnouncementGroup?: boolean
}

export type EventMessageOptions = {
	name: string
	description?: string
	startDate: Date
	endDate?: Date
	location?: WALocationMessage
	call?: 'audio' | 'video'
	isCancelled?: boolean
	isScheduleCall?: boolean
	extraGuestsAllowed?: boolean
	messageSecret?: Uint8Array<ArrayBufferLike>
}

type SharePhoneNumber = {
	sharePhoneNumber: boolean
}

type RequestPhoneNumber = {
	requestPhoneNumber: boolean
}

export type AnyMediaMessageContent = (
	| ({
			image: WAMediaUpload
			caption?: string
			jpegThumbnail?: string
	  } & Mentionable &
			Contextable &
			WithDimensions)
	| ({
			video: WAMediaUpload
			caption?: string
			gifPlayback?: boolean
			jpegThumbnail?: string
			/** if set to true, will send as a `video note` */
			ptv?: boolean
	  } & Mentionable &
			Contextable &
			WithDimensions)
	| {
			audio: WAMediaUpload
			/** if set to true, will send as a `voice note` */
			ptt?: boolean
			/** optionally tell the duration of the audio */
			seconds?: number
	  }
	| ({
			sticker: WAMediaUpload
			isAnimated?: boolean
	  } & WithDimensions)
	| ({
			document: WAMediaUpload
			mimetype: string
			fileName?: string
			caption?: string
	  } & Contextable)
) & { mimetype?: string } & Editable

export type ButtonReplyInfo = {
	displayText: string
	id: string
	index: number
}

export type GroupInviteInfo = {
	inviteCode: string
	inviteExpiration: number
	text: string
	jid: string
	subject: string
}

export type WASendableProduct = Omit<proto.Message.ProductMessage.IProductSnapshot, 'productImage'> & {
	productImage: WAMediaUpload
}

export type AnyRegularMessageContent = (
	| ({
			text: string
			linkPreview?: WAUrlInfo | null
	  } & Mentionable &
			Contextable &
			Editable)
	| AnyMediaMessageContent
	| { event: EventMessageOptions }
	| ({
			poll: PollMessageOptions
	  } & Mentionable &
			Contextable &
			Editable)
	| {
			contacts: {
				displayName?: string
				contacts: proto.Message.IContactMessage[]
			}
	  }
	| {
			location: WALocationMessage
	  }
	| { react: proto.Message.IReactionMessage }
	| {
			buttonReply: ButtonReplyInfo
			type: 'template' | 'plain'
	  }
	| {
			groupInvite: GroupInviteInfo
	  }
	| {
			listReply: Omit<proto.Message.IListResponseMessage, 'contextInfo'>
	  }
	| {
			pin: WAMessageKey
			type: proto.PinInChat.Type
			/**
			 * 24 hours, 7 days, 30 days
			 */
			time?: 86400 | 604800 | 2592000
	  }
	| {
			product: WASendableProduct
			businessOwnerJid?: string
			body?: string
			footer?: string
	  }
	| SharePhoneNumber
	| RequestPhoneNumber
) &
	ViewOnce

export type AnyMessageContent =
	| AnyRegularMessageContent
	| {
			forward: WAMessage
			force?: boolean
	  }
	| {
			/** Delete your message or anyone's message in a group (admin required) */
			delete: WAMessageKey
	  }
	| {
			disappearingMessagesInChat: boolean | number
	  }
	| {
			limitSharing: boolean
	  }

export type GroupMetadataParticipants = Pick<GroupMetadata, 'participants'>

type MinimalRelayOptions = {
	/** override the message ID with a custom provided string */
	messageId?: string
	/** should we use group metadata cache, or fetch afresh from the server; default assumed to be "true" */
	useCachedGroupMetadata?: boolean
}

export type MessageRelayOptions = MinimalRelayOptions & {
	/** only send to a specific participant; used when a message decryption fails for a single user */
	participant?: { jid: string; count: number }
	/** additional attributes to add to the WA binary node */
	additionalAttributes?: { [_: string]: string }
	additionalNodes?: BinaryNode[]
	/** should we use the devices cache, or fetch afresh from the server; default assumed to be "true" */
	useUserDevicesCache?: boolean
	/** jid list of participants for status@broadcast */
	statusJidList?: string[]
}

export type MiscMessageGenerationOptions = MinimalRelayOptions & {
	/** optional, if you want to manually set the timestamp of the message */
	timestamp?: Date
	/** the message you want to quote */
	quoted?: WAMessage
	/** disappearing messages settings */
	ephemeralExpiration?: number | string
	/** timeout for media upload to WA server */
	mediaUploadTimeoutMs?: number
	/** jid list of participants for status@broadcast */
	statusJidList?: string[]
	/** backgroundcolor for status */
	backgroundColor?: string
	/** font type for status */
	font?: number
	/** if it is broadcast */
	broadcast?: boolean
}
export type MessageGenerationOptionsFromContent = MiscMessageGenerationOptions & {
	userJid: string
}

export type WAMediaUploadFunction = (
	encFilePath: string,
	opts: { fileEncSha256B64: string; mediaType: MediaType; timeoutMs?: number }
) => Promise<{ mediaUrl: string; directPath: string; meta_hmac?: string; ts?: number; fbid?: number }>

export type MediaGenerationOptions = {
	logger?: ILogger
	mediaTypeOverride?: MediaType
	upload: WAMediaUploadFunction
	/** cache media so it does not have to be uploaded again */
	mediaCache?: CacheStore

	mediaUploadTimeoutMs?: number

	options?: RequestInit

	backgroundColor?: string

	font?: number
}
export type MessageContentGenerationOptions = MediaGenerationOptions & {
	getUrlInfo?: (text: string) => Promise<WAUrlInfo | undefined>
	getProfilePicUrl?: (jid: string, type: 'image' | 'preview') => Promise<string | undefined>
	getCallLink?: (type: 'audio' | 'video', event?: { startTime: number }) => Promise<string | undefined>
	jid?: string
}
export type MessageGenerationOptions = MessageContentGenerationOptions & MessageGenerationOptionsFromContent

/**
 * Type of message upsert
 * 1. notify => notify the user, this message was just received
 * 2. append => append the message to the chat history, no notification required
 */
export type MessageUpsertType = 'append' | 'notify'

export type MessageUserReceipt = proto.IUserReceipt

export type WAMessageUpdate = { update: Partial<WAMessage>; key: WAMessageKey }

export type WAMessageCursor = { before: WAMessageKey | undefined } | { after: WAMessageKey | undefined }

export type MessageUserReceiptUpdate = { key: WAMessageKey; receipt: MessageUserReceipt }

export type MediaDecryptionKeyInfo = {
	iv: Buffer
	cipherKey: Buffer
	macKey?: Buffer
}

export type MinimalMessage = Pick<WAMessage, 'key' | 'messageTimestamp'>



================================================
FILE: src/Types/Newsletter.ts
================================================
export enum XWAPaths {
	xwa2_newsletter_create = 'xwa2_newsletter_create',
	xwa2_newsletter_subscribers = 'xwa2_newsletter_subscribers',
	xwa2_newsletter_view = 'xwa2_newsletter_view',
	xwa2_newsletter_metadata = 'xwa2_newsletter',
	xwa2_newsletter_admin_count = 'xwa2_newsletter_admin',
	xwa2_newsletter_mute_v2 = 'xwa2_newsletter_mute_v2',
	xwa2_newsletter_unmute_v2 = 'xwa2_newsletter_unmute_v2',
	xwa2_newsletter_follow = 'xwa2_newsletter_follow',
	xwa2_newsletter_unfollow = 'xwa2_newsletter_unfollow',
	xwa2_newsletter_change_owner = 'xwa2_newsletter_change_owner',
	xwa2_newsletter_demote = 'xwa2_newsletter_demote',
	xwa2_newsletter_delete_v2 = 'xwa2_newsletter_delete_v2'
}
export enum QueryIds {
	CREATE = '8823471724422422',
	UPDATE_METADATA = '24250201037901610',
	METADATA = '6563316087068696',
	SUBSCRIBERS = '9783111038412085',
	FOLLOW = '7871414976211147',
	UNFOLLOW = '7238632346214362',
	MUTE = '29766401636284406',
	UNMUTE = '9864994326891137',
	ADMIN_COUNT = '7130823597031706',
	CHANGE_OWNER = '7341777602580933',
	DEMOTE = '6551828931592903',
	DELETE = '30062808666639665'
}
export type NewsletterUpdate = {
	name?: string
	description?: string
	picture?: string
}
export interface NewsletterCreateResponse {
	id: string
	state: { type: string }
	thread_metadata: {
		creation_time: string
		description: { id: string; text: string; update_time: string }
		handle: string | null
		invite: string
		name: { id: string; text: string; update_time: string }
		picture: { direct_path: string; id: string; type: string }
		preview: { direct_path: string; id: string; type: string }
		subscribers_count: string
		verification: 'VERIFIED' | 'UNVERIFIED'
	}
	viewer_metadata: {
		mute: 'ON' | 'OFF'
		role: NewsletterViewRole
	}
}
export interface NewsletterCreateResponse {
	id: string
	state: { type: string }
	thread_metadata: {
		creation_time: string
		description: { id: string; text: string; update_time: string }
		handle: string | null
		invite: string
		name: { id: string; text: string; update_time: string }
		picture: { direct_path: string; id: string; type: string }
		preview: { direct_path: string; id: string; type: string }
		subscribers_count: string
		verification: 'VERIFIED' | 'UNVERIFIED'
	}
	viewer_metadata: {
		mute: 'ON' | 'OFF'
		role: NewsletterViewRole
	}
}
export type NewsletterViewRole = 'ADMIN' | 'GUEST' | 'OWNER' | 'SUBSCRIBER'
export interface NewsletterMetadata {
	id: string
	owner?: string
	name: string
	description?: string
	invite?: string
	creation_time?: number
	subscribers?: number
	picture?: {
		url?: string
		directPath?: string
		mediaKey?: string
		id?: string
	}
	verification?: 'VERIFIED' | 'UNVERIFIED'
	reaction_codes?: {
		code: string
		count: number
	}[]
	mute_state?: 'ON' | 'OFF'
	thread_metadata?: {
		creation_time?: number
		name?: string
		description?: string
	}
}



================================================
FILE: src/Types/Product.ts
================================================
import type { WAMediaUpload } from './Message'

export type CatalogResult = {
	data: {
		paging: { cursors: { before: string; after: string } }
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		data: any[]
	}
}

export type ProductCreateResult = {
	data: { product: {} }
}

export type CatalogStatus = {
	status: string
	canAppeal: boolean
}

export type CatalogCollection = {
	id: string
	name: string
	products: Product[]

	status: CatalogStatus
}

export type ProductAvailability = 'in stock'

export type ProductBase = {
	name: string
	retailerId?: string
	url?: string
	description: string
	price: number
	currency: string
	isHidden?: boolean
}

export type ProductCreate = ProductBase & {
	/** ISO country code for product origin. Set to undefined for no country */
	originCountryCode: string | undefined
	/** images of the product */
	images: WAMediaUpload[]
}

export type ProductUpdate = Omit<ProductCreate, 'originCountryCode'>

export type Product = ProductBase & {
	id: string
	imageUrls: { [_: string]: string }
	reviewStatus: { [_: string]: string }
	availability: ProductAvailability
}

export type OrderPrice = {
	currency: string
	total: number
}

export type OrderProduct = {
	id: string
	imageUrl: string
	name: string
	quantity: number

	currency: string
	price: number
}

export type OrderDetails = {
	price: OrderPrice
	products: OrderProduct[]
}

export type CatalogCursor = string

export type GetCatalogOptions = {
	/** cursor to start from */
	cursor?: CatalogCursor
	/** number of products to fetch */
	limit?: number

	jid?: string
}



================================================
FILE: src/Types/Signal.ts
================================================
import { proto } from '../../WAProto/index.js'
import type { LIDMappingStore } from '../Signal/lid-mapping'

type DecryptGroupSignalOpts = {
	group: string
	authorJid: string
	msg: Uint8Array
}

type ProcessSenderKeyDistributionMessageOpts = {
	item: proto.Message.ISenderKeyDistributionMessage
	authorJid: string
}

type DecryptSignalProtoOpts = {
	jid: string
	type: 'pkmsg' | 'msg'
	ciphertext: Uint8Array
}

type EncryptMessageOpts = {
	jid: string
	data: Uint8Array
}

type EncryptGroupMessageOpts = {
	group: string
	data: Uint8Array
	meId: string
}

type PreKey = {
	keyId: number
	publicKey: Uint8Array
}

type SignedPreKey = PreKey & {
	signature: Uint8Array
}

type E2ESession = {
	registrationId: number
	identityKey: Uint8Array
	signedPreKey: SignedPreKey
	preKey: PreKey
}

type E2ESessionOpts = {
	jid: string
	session: E2ESession
}

export type SignalRepository = {
	decryptGroupMessage(opts: DecryptGroupSignalOpts): Promise<Uint8Array>
	processSenderKeyDistributionMessage(opts: ProcessSenderKeyDistributionMessageOpts): Promise<void>
	decryptMessage(opts: DecryptSignalProtoOpts): Promise<Uint8Array>
	encryptMessage(opts: EncryptMessageOpts): Promise<{
		type: 'pkmsg' | 'msg'
		ciphertext: Uint8Array
	}>
	encryptGroupMessage(opts: EncryptGroupMessageOpts): Promise<{
		senderKeyDistributionMessage: Uint8Array
		ciphertext: Uint8Array
	}>
	injectE2ESession(opts: E2ESessionOpts): Promise<void>
	validateSession(jid: string): Promise<{ exists: boolean; reason?: string }>
	jidToSignalProtocolAddress(jid: string): string
	migrateSession(fromJid: string, toJid: string): Promise<{ migrated: number; skipped: number; total: number }>
	validateSession(jid: string): Promise<{ exists: boolean; reason?: string }>
	deleteSession(jids: string[]): Promise<void>
}

// Optimized repository with pre-loaded LID mapping store
export interface SignalRepositoryWithLIDStore extends SignalRepository {
	lidMapping: LIDMappingStore
}



================================================
FILE: src/Types/Socket.ts
================================================
import type { Agent } from 'https'
import type { URL } from 'url'
import { proto } from '../../WAProto/index.js'
import type { ILogger } from '../Utils/logger'
import type { AuthenticationState, LIDMapping, SignalAuthState, TransactionCapabilityOptions } from './Auth'
import type { GroupMetadata } from './GroupMetadata'
import { type MediaConnInfo, type WAMessageKey } from './Message'
import type { SignalRepositoryWithLIDStore } from './Signal'

export type WAVersion = [number, number, number]
export type WABrowserDescription = [string, string, string]

export type CacheStore = {
	/** get a cached key and change the stats */
	get<T>(key: string): Promise<T> | T | undefined
	/** set a key in the cache */
	set<T>(key: string, value: T): Promise<void> | void | number | boolean
	/** delete a key from the cache */
	del(key: string): void | Promise<void> | number | boolean
	/** flush all data */
	flushAll(): void | Promise<void>
}

export type PossiblyExtendedCacheStore = CacheStore & {
	mget?: <T>(keys: string[]) => Promise<Record<string, T | undefined>>
	mset?: <T>(entries: { key: string; value: T }[]) => Promise<void> | void | number | boolean
	mdel?: (keys: string[]) => void | Promise<void> | number | boolean
}

export type PatchedMessageWithRecipientJID = proto.IMessage & { recipientJid?: string }

export type SocketConfig = {
	/** the WS url to connect to WA */
	waWebSocketUrl: string | URL
	/** Fails the connection if the socket times out in this interval */
	connectTimeoutMs: number
	/** Default timeout for queries, undefined for no timeout */
	defaultQueryTimeoutMs: number | undefined
	/** ping-pong interval for WS connection */
	keepAliveIntervalMs: number
	/** should baileys use the mobile api instead of the multi device api
	 * @deprecated This feature has been removed
	 */
	mobile?: boolean
	/** proxy agent */
	agent?: Agent
	/** logger */
	logger: ILogger
	/** version to connect with */
	version: WAVersion
	/** override browser config */
	browser: WABrowserDescription
	/** agent used for fetch requests -- uploading/downloading media */
	fetchAgent?: Agent
	/** should the QR be printed in the terminal
	 * @deprecated This feature has been removed
	 */
	printQRInTerminal?: boolean
	/** should events be emitted for actions done by this socket connection */
	emitOwnEvents: boolean
	/** custom upload hosts to upload media to */
	customUploadHosts: MediaConnInfo['hosts']
	/** time to wait between sending new retry requests */
	retryRequestDelayMs: number
	/** max retry count */
	maxMsgRetryCount: number
	/** time to wait for the generation of the next QR in ms */
	qrTimeout?: number
	/** provide an auth state object to maintain the auth state */
	auth: AuthenticationState
	/** manage history processing with this control; by default will sync up everything */
	shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => boolean
	/** transaction capability options for SignalKeyStore */
	transactionOpts: TransactionCapabilityOptions
	/** marks the client as online whenever the socket successfully connects */
	markOnlineOnConnect: boolean
	/** alphanumeric country code (USA -> US) for the number used */
	countryCode: string
	/** provide a cache to store media, so does not have to be re-uploaded */
	mediaCache?: CacheStore
	/**
	 * map to store the retry counts for failed messages;
	 * used to determine whether to retry a message or not */
	msgRetryCounterCache?: CacheStore
	/** provide a cache to store a user's device list */
	userDevicesCache?: PossiblyExtendedCacheStore
	/** cache to store call offers */
	callOfferCache?: CacheStore
	/** cache to track placeholder resends */
	placeholderResendCache?: CacheStore
	/** width for link preview images */
	linkPreviewImageThumbnailWidth: number
	/** Should Baileys ask the phone for full history, will be received async */
	syncFullHistory: boolean
	/** Should baileys fire init queries automatically, default true */
	fireInitQueries: boolean
	/**
	 * generate a high quality link preview,
	 * entails uploading the jpegThumbnail to WA
	 * */
	generateHighQualityLinkPreview: boolean

	/** Enable automatic session recreation for failed messages */
	enableAutoSessionRecreation: boolean

	/** Enable recent message caching for retry handling */
	enableRecentMessageCache: boolean

	/**
	 * Returns if a jid should be ignored,
	 * no event for that jid will be triggered.
	 * Messages from that jid will also not be decrypted
	 * */
	shouldIgnoreJid: (jid: string) => boolean | undefined

	/**
	 * Optionally patch the message before sending out
	 * */
	patchMessageBeforeSending: (
		msg: proto.IMessage,
		recipientJids?: string[]
	) =>
		| Promise<PatchedMessageWithRecipientJID[] | PatchedMessageWithRecipientJID>
		| PatchedMessageWithRecipientJID[]
		| PatchedMessageWithRecipientJID

	/** verify app state MACs */
	appStateMacVerification: {
		patch: boolean
		snapshot: boolean
	}

	/** options for HTTP fetch requests */
	options: RequestInit
	/**
	 * fetch a message from your store
	 * implement this so that messages failed to send
	 * (solves the "this message can take a while" issue) can be retried
	 * */
	getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>

	/** cached group metadata, use to prevent redundant requests to WA & speed up msg sending */
	cachedGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>

	makeSignalRepository: (
		auth: SignalAuthState,
		logger: ILogger,
		pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>
	) => SignalRepositoryWithLIDStore
}



================================================
FILE: src/Types/State.ts
================================================
import { Boom } from '@hapi/boom'
import type { Contact } from './Contact'

export enum SyncState {
	/** The socket is connecting, but we haven't received pending notifications yet. */
	Connecting,
	/** Pending notifications received. Buffering events until we decide whether to sync or not. */
	AwaitingInitialSync,
	/** The initial app state sync (history, etc.) is in progress. Buffering continues. */
	Syncing,
	/** Initial sync is complete, or was skipped. The socket is fully operational and events are processed in real-time. */
	Online
}

export type WAConnectionState = 'open' | 'connecting' | 'close'

export type ConnectionState = {
	/** connection is now open, connecting or closed */
	connection: WAConnectionState

	/** the error that caused the connection to close */
	lastDisconnect?: {
		// TODO: refactor and gain independence from Boom
		error: Boom | Error | undefined
		date: Date
	}
	/** is this a new login */
	isNewLogin?: boolean
	/** the current QR code */
	qr?: string
	/** has the device received all pending notifications while it was offline */
	receivedPendingNotifications?: boolean
	/** legacy connection options */
	legacy?: {
		phoneConnected: boolean
		user?: Contact
	}
	/**
	 * if the client is shown as an active, online client.
	 * If this is false, the primary phone and other devices will receive notifs
	 * */
	isOnline?: boolean
}



================================================
FILE: src/Types/USync.ts
================================================
import type { BinaryNode } from '../WABinary'
import { USyncUser } from '../WAUSync'

/**
 * Defines the interface for a USyncQuery protocol
 */
export interface USyncQueryProtocol {
	/**
	 * The name of the protocol
	 */
	name: string
	/**
	 * Defines what goes inside the query part of a USyncQuery
	 */
	getQueryElement: () => BinaryNode
	/**
	 * Defines what goes inside the user part of a USyncQuery
	 */
	getUserElement: (user: USyncUser) => BinaryNode | null

	/**
	 * Parse the result of the query
	 * @param data Data from the result
	 * @returns Whatever the protocol is supposed to return
	 */
	parser: (data: BinaryNode) => unknown
}



================================================
FILE: src/Utils/auth-utils.ts
================================================
import NodeCache from '@cacheable/node-cache'
import { AsyncLocalStorage } from 'async_hooks'
import { Mutex } from 'async-mutex'
import { randomBytes } from 'crypto'
import PQueue from 'p-queue'
import { DEFAULT_CACHE_TTLS } from '../Defaults'
import type {
	AuthenticationCreds,
	CacheStore,
	SignalDataSet,
	SignalDataTypeMap,
	SignalKeyStore,
	SignalKeyStoreWithTransaction,
	TransactionCapabilityOptions
} from '../Types'
import { Curve, signedKeyPair } from './crypto'
import { delay, generateRegistrationId } from './generics'
import type { ILogger } from './logger'
import { PreKeyManager } from './pre-key-manager'

/**
 * Transaction context stored in AsyncLocalStorage
 */
interface TransactionContext {
	cache: SignalDataSet
	mutations: SignalDataSet
	dbQueries: number
}

/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export function makeCacheableSignalKeyStore(
	store: SignalKeyStore,
	logger?: ILogger,
	_cache?: CacheStore
): SignalKeyStore {
	const cache =
		_cache ||
		new NodeCache<SignalDataTypeMap[keyof SignalDataTypeMap]>({
			stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, // 5 minutes
			useClones: false,
			deleteOnExpire: true
		})

	// Mutex for protecting cache operations
	const cacheMutex = new Mutex()

	function getUniqueId(type: string, id: string) {
		return `${type}.${id}`
	}

	return {
		async get(type, ids) {
			return cacheMutex.runExclusive(async () => {
				const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
				const idsToFetch: string[] = []

				for (const id of ids) {
					const item = (await cache.get<SignalDataTypeMap[typeof type]>(getUniqueId(type, id))) as any
					if (typeof item !== 'undefined') {
						data[id] = item
					} else {
						idsToFetch.push(id)
					}
				}

				if (idsToFetch.length) {
					logger?.trace({ items: idsToFetch.length }, 'loading from store')
					const fetched = await store.get(type, idsToFetch)
					for (const id of idsToFetch) {
						const item = fetched[id]
						if (item) {
							data[id] = item
							cache.set(getUniqueId(type, id), item)
						}
					}
				}

				return data
			})
		},
		async set(data) {
			return cacheMutex.runExclusive(async () => {
				let keys = 0
				for (const type in data) {
					for (const id in data[type as keyof SignalDataTypeMap]) {
						await cache.set(getUniqueId(type, id), data[type as keyof SignalDataTypeMap]![id]!)
						keys += 1
					}
				}

				logger?.trace({ keys }, 'updated cache')
				await store.set(data)
			})
		},
		async clear() {
			await cache.flushAll()
			await store.clear?.()
		}
	}
}

/**
 * Adds DB-like transaction capability to the SignalKeyStore
 * Uses AsyncLocalStorage for automatic context management
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (
	state: SignalKeyStore,
	logger: ILogger,
	{ maxCommitRetries, delayBetweenTriesMs }: TransactionCapabilityOptions
): SignalKeyStoreWithTransaction => {
	const txStorage = new AsyncLocalStorage<TransactionContext>()

	// Queues for concurrency control
	const keyQueues = new Map<string, PQueue>()
	const txMutexes = new Map<string, Mutex>()

	// Pre-key manager for specialized operations
	const preKeyManager = new PreKeyManager(state, logger)

	/**
	 * Get or create a queue for a specific key type
	 */
	function getQueue(key: string): PQueue {
		if (!keyQueues.has(key)) {
			keyQueues.set(key, new PQueue({ concurrency: 1 }))
		}

		return keyQueues.get(key)!
	}

	/**
	 * Get or create a transaction mutex
	 */
	function getTxMutex(key: string): Mutex {
		if (!txMutexes.has(key)) {
			txMutexes.set(key, new Mutex())
		}

		return txMutexes.get(key)!
	}

	/**
	 * Check if currently in a transaction
	 */
	function isInTransaction(): boolean {
		return !!txStorage.getStore()
	}

	/**
	 * Commit transaction with retries
	 */
	async function commitWithRetry(mutations: SignalDataSet): Promise<void> {
		if (Object.keys(mutations).length === 0) {
			logger.trace('no mutations in transaction')
			return
		}

		logger.trace('committing transaction')

		for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
			try {
				await state.set(mutations)
				logger.trace({ mutationCount: Object.keys(mutations).length }, 'committed transaction')
				return
			} catch (error) {
				const retriesLeft = maxCommitRetries - attempt - 1
				logger.warn(`failed to commit mutations, retries left=${retriesLeft}`)

				if (retriesLeft === 0) {
					throw error
				}

				await delay(delayBetweenTriesMs)
			}
		}
	}

	return {
		get: async (type, ids) => {
			const ctx = txStorage.getStore()

			if (!ctx) {
				// No transaction - direct read without exclusive lock for concurrency
				return state.get(type, ids)
			}

			// In transaction - check cache first
			const cached = ctx.cache[type] || {}
			const missing = ids.filter(id => !(id in cached))

			if (missing.length > 0) {
				ctx.dbQueries++
				logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction')

				const fetched = await getTxMutex(type).runExclusive(() => state.get(type, missing))

				// Update cache
				ctx.cache[type] = ctx.cache[type] || ({} as any)
				Object.assign(ctx.cache[type]!, fetched)
			}

			// Return requested ids from cache
			const result: { [key: string]: any } = {}
			for (const id of ids) {
				const value = ctx.cache[type]?.[id]
				if (value !== undefined && value !== null) {
					result[id] = value
				}
			}

			return result
		},

		set: async data => {
			const ctx = txStorage.getStore()

			if (!ctx) {
				// No transaction - direct write with queue protection
				const types = Object.keys(data)

				// Process pre-keys with validation
				for (const type_ of types) {
					const type = type_ as keyof SignalDataTypeMap
					if (type === 'pre-key') {
						await preKeyManager.validateDeletions(data, type)
					}
				}

				// Write all data in parallel
				await Promise.all(
					types.map(type =>
						getQueue(type).add(async () => {
							const typeData = { [type]: data[type as keyof SignalDataTypeMap] } as SignalDataSet
							await state.set(typeData)
						})
					)
				)
				return
			}

			// In transaction - update cache and mutations
			logger.trace({ types: Object.keys(data) }, 'caching in transaction')

			for (const key_ in data) {
				const key = key_ as keyof SignalDataTypeMap

				// Ensure structures exist
				ctx.cache[key] = ctx.cache[key] || ({} as any)
				ctx.mutations[key] = ctx.mutations[key] || ({} as any)

				// Special handling for pre-keys
				if (key === 'pre-key') {
					await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true)
				} else {
					// Normal key types
					Object.assign(ctx.cache[key]!, data[key])
					Object.assign(ctx.mutations[key]!, data[key])
				}
			}
		},

		isInTransaction,

		transaction: async (work, key) => {
			const existing = txStorage.getStore()

			// Nested transaction - reuse existing context
			if (existing) {
				logger.trace('reusing existing transaction context')
				return work()
			}

			// New transaction - acquire mutex and create context
			return getTxMutex(key).runExclusive(async () => {
				const ctx: TransactionContext = {
					cache: {},
					mutations: {},
					dbQueries: 0
				}

				logger.trace('entering transaction')

				try {
					const result = await txStorage.run(ctx, work)

					// Commit mutations
					await commitWithRetry(ctx.mutations)

					logger.trace({ dbQueries: ctx.dbQueries }, 'transaction completed')

					return result
				} catch (error) {
					logger.error({ error }, 'transaction failed, rolling back')
					throw error
				}
			})
		}
	}
}

export const initAuthCreds = (): AuthenticationCreds => {
	const identityKey = Curve.generateKeyPair()
	return {
		noiseKey: Curve.generateKeyPair(),
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32).toString('base64'),
		processedHistoryMessages: [],
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false
		},
		registered: false,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: undefined,
		additionalData: undefined
	}
}



================================================
FILE: src/Utils/baileys-event-stream.ts
================================================
import EventEmitter from 'events'
import { createReadStream } from 'fs'
import { writeFile } from 'fs/promises'
import { createInterface } from 'readline'
import type { BaileysEventEmitter } from '../Types'
import { delay } from './generics'
import { makeMutex } from './make-mutex'

/**
 * Captures events from a baileys event emitter & stores them in a file
 * @param ev The event emitter to read events from
 * @param filename File to save to
 */
export const captureEventStream = (ev: BaileysEventEmitter, filename: string) => {
	const oldEmit = ev.emit
	// write mutex so data is appended in order
	const writeMutex = makeMutex()
	// monkey patch eventemitter to capture all events
	ev.emit = function (...args: any[]) {
		const content = JSON.stringify({ timestamp: Date.now(), event: args[0], data: args[1] }) + '\n'
		const result = oldEmit.apply(ev, args as any)

		writeMutex.mutex(async () => {
			await writeFile(filename, content, { flag: 'a' })
		})

		return result
	}
}

/**
 * Read event file and emit events from there
 * @param filename filename containing event data
 * @param delayIntervalMs delay between each event emit
 */
export const readAndEmitEventStream = (filename: string, delayIntervalMs = 0) => {
	const ev = new EventEmitter() as BaileysEventEmitter

	const fireEvents = async () => {
		// from: https://stackoverflow.com/questions/6156501/read-a-file-one-line-at-a-time-in-node-js
		const fileStream = createReadStream(filename)

		const rl = createInterface({
			input: fileStream,
			crlfDelay: Infinity
		})
		// Note: we use the crlfDelay option to recognize all instances of CR LF
		// ('\r\n') in input.txt as a single line break.
		for await (const line of rl) {
			if (line) {
				const { event, data } = JSON.parse(line)
				ev.emit(event, data)
				delayIntervalMs && (await delay(delayIntervalMs))
			}
		}

		fileStream.close()
	}

	return {
		ev,
		task: fireEvents()
	}
}



================================================
FILE: src/Utils/browser-utils.ts
================================================
import { platform, release } from 'os'
import { proto } from '../../WAProto/index.js'
import type { BrowsersMap } from '../Types'

const PLATFORM_MAP = {
	aix: 'AIX',
	darwin: 'Mac OS',
	win32: 'Windows',
	android: 'Android',
	freebsd: 'FreeBSD',
	openbsd: 'OpenBSD',
	sunos: 'Solaris',
	linux: undefined,
	haiku: undefined,
	cygwin: undefined,
	netbsd: undefined
}

export const Browsers: BrowsersMap = {
	ubuntu: browser => ['Ubuntu', browser, '22.04.4'],
	macOS: browser => ['Mac OS', browser, '14.4.1'],
	baileys: browser => ['Baileys', browser, '6.5.0'],
	windows: browser => ['Windows', browser, '10.0.22631'],
	/** The appropriate browser based on your OS & release */
	appropriate: browser => [PLATFORM_MAP[platform()] || 'Ubuntu', browser, release()]
}

export const getPlatformId = (browser: string) => {
	const platformType = proto.DeviceProps.PlatformType[browser.toUpperCase() as any]
	return platformType ? platformType.toString() : '1' //chrome
}



================================================
FILE: src/Utils/business.ts
================================================
import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { createWriteStream, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
	CatalogCollection,
	CatalogStatus,
	OrderDetails,
	OrderProduct,
	Product,
	ProductCreate,
	ProductUpdate,
	WAMediaUpload,
	WAMediaUploadFunction
} from '../Types'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../WABinary'
import { generateMessageIDV2 } from './generics'
import { getStream, getUrlFromDirectPath } from './messages-media'

export const parseCatalogNode = (node: BinaryNode) => {
	const catalogNode = getBinaryNodeChild(node, 'product_catalog')
	const products = getBinaryNodeChildren(catalogNode, 'product').map(parseProductNode)
	const paging = getBinaryNodeChild(catalogNode, 'paging')

	return {
		products,
		nextPageCursor: paging ? getBinaryNodeChildString(paging, 'after') : undefined
	}
}

export const parseCollectionsNode = (node: BinaryNode) => {
	const collectionsNode = getBinaryNodeChild(node, 'collections')
	const collections = getBinaryNodeChildren(collectionsNode, 'collection').map<CatalogCollection>(collectionNode => {
		const id = getBinaryNodeChildString(collectionNode, 'id')!
		const name = getBinaryNodeChildString(collectionNode, 'name')!

		const products = getBinaryNodeChildren(collectionNode, 'product').map(parseProductNode)
		return {
			id,
			name,
			products,
			status: parseStatusInfo(collectionNode)
		}
	})

	return {
		collections
	}
}

export const parseOrderDetailsNode = (node: BinaryNode) => {
	const orderNode = getBinaryNodeChild(node, 'order')
	const products = getBinaryNodeChildren(orderNode, 'product').map<OrderProduct>(productNode => {
		const imageNode = getBinaryNodeChild(productNode, 'image')!
		return {
			id: getBinaryNodeChildString(productNode, 'id')!,
			name: getBinaryNodeChildString(productNode, 'name')!,
			imageUrl: getBinaryNodeChildString(imageNode, 'url')!,
			price: +getBinaryNodeChildString(productNode, 'price')!,
			currency: getBinaryNodeChildString(productNode, 'currency')!,
			quantity: +getBinaryNodeChildString(productNode, 'quantity')!
		}
	})

	const priceNode = getBinaryNodeChild(orderNode, 'price')

	const orderDetails: OrderDetails = {
		price: {
			total: +getBinaryNodeChildString(priceNode, 'total')!,
			currency: getBinaryNodeChildString(priceNode, 'currency')!
		},
		products
	}

	return orderDetails
}

export const toProductNode = (productId: string | undefined, product: ProductCreate | ProductUpdate) => {
	const attrs: BinaryNode['attrs'] = {}
	const content: BinaryNode[] = []

	if (typeof productId !== 'undefined') {
		content.push({
			tag: 'id',
			attrs: {},
			content: Buffer.from(productId)
		})
	}

	if (typeof product.name !== 'undefined') {
		content.push({
			tag: 'name',
			attrs: {},
			content: Buffer.from(product.name)
		})
	}

	if (typeof product.description !== 'undefined') {
		content.push({
			tag: 'description',
			attrs: {},
			content: Buffer.from(product.description)
		})
	}

	if (typeof product.retailerId !== 'undefined') {
		content.push({
			tag: 'retailer_id',
			attrs: {},
			content: Buffer.from(product.retailerId)
		})
	}

	if (product.images.length) {
		content.push({
			tag: 'media',
			attrs: {},
			content: product.images.map(img => {
				if (!('url' in img)) {
					throw new Boom('Expected img for product to already be uploaded', { statusCode: 400 })
				}

				return {
					tag: 'image',
					attrs: {},
					content: [
						{
							tag: 'url',
							attrs: {},
							content: Buffer.from(img.url.toString())
						}
					]
				}
			})
		})
	}

	if (typeof product.price !== 'undefined') {
		content.push({
			tag: 'price',
			attrs: {},
			content: Buffer.from(product.price.toString())
		})
	}

	if (typeof product.currency !== 'undefined') {
		content.push({
			tag: 'currency',
			attrs: {},
			content: Buffer.from(product.currency)
		})
	}

	if ('originCountryCode' in product) {
		if (typeof product.originCountryCode === 'undefined') {
			attrs['compliance_category'] = 'COUNTRY_ORIGIN_EXEMPT'
		} else {
			content.push({
				tag: 'compliance_info',
				attrs: {},
				content: [
					{
						tag: 'country_code_origin',
						attrs: {},
						content: Buffer.from(product.originCountryCode)
					}
				]
			})
		}
	}

	if (typeof product.isHidden !== 'undefined') {
		attrs['is_hidden'] = product.isHidden.toString()
	}

	const node: BinaryNode = {
		tag: 'product',
		attrs,
		content
	}
	return node
}

export const parseProductNode = (productNode: BinaryNode) => {
	const isHidden = productNode.attrs.is_hidden === 'true'
	const id = getBinaryNodeChildString(productNode, 'id')!

	const mediaNode = getBinaryNodeChild(productNode, 'media')!
	const statusInfoNode = getBinaryNodeChild(productNode, 'status_info')!

	const product: Product = {
		id,
		imageUrls: parseImageUrls(mediaNode),
		reviewStatus: {
			whatsapp: getBinaryNodeChildString(statusInfoNode, 'status')!
		},
		availability: 'in stock',
		name: getBinaryNodeChildString(productNode, 'name')!,
		retailerId: getBinaryNodeChildString(productNode, 'retailer_id'),
		url: getBinaryNodeChildString(productNode, 'url'),
		description: getBinaryNodeChildString(productNode, 'description')!,
		price: +getBinaryNodeChildString(productNode, 'price')!,
		currency: getBinaryNodeChildString(productNode, 'currency')!,
		isHidden
	}

	return product
}

/**
 * Uploads images not already uploaded to WA's servers
 */
export async function uploadingNecessaryImagesOfProduct<T extends ProductUpdate | ProductCreate>(
	product: T,
	waUploadToServer: WAMediaUploadFunction,
	timeoutMs = 30_000
) {
	product = {
		...product,
		images: product.images
			? await uploadingNecessaryImages(product.images, waUploadToServer, timeoutMs)
			: product.images
	}
	return product
}

/**
 * Uploads images not already uploaded to WA's servers
 */
export const uploadingNecessaryImages = async (
	images: WAMediaUpload[],
	waUploadToServer: WAMediaUploadFunction,
	timeoutMs = 30_000
) => {
	const results = await Promise.all(
		images.map<Promise<{ url: string }>>(async img => {
			if ('url' in img) {
				const url = img.url.toString()
				if (url.includes('.whatsapp.net')) {
					return { url }
				}
			}

			const { stream } = await getStream(img)
			const hasher = createHash('sha256')

			const filePath = join(tmpdir(), 'img' + generateMessageIDV2())
			const encFileWriteStream = createWriteStream(filePath)

			for await (const block of stream) {
				hasher.update(block)
				encFileWriteStream.write(block)
			}

			const sha = hasher.digest('base64')

			const { directPath } = await waUploadToServer(filePath, {
				mediaType: 'product-catalog-image',
				fileEncSha256B64: sha,
				timeoutMs
			})

			await fs.unlink(filePath).catch(err => console.log('Error deleting temp file ', err))

			return { url: getUrlFromDirectPath(directPath) }
		})
	)
	return results
}

const parseImageUrls = (mediaNode: BinaryNode) => {
	const imgNode = getBinaryNodeChild(mediaNode, 'image')
	return {
		requested: getBinaryNodeChildString(imgNode, 'request_image_url')!,
		original: getBinaryNodeChildString(imgNode, 'original_image_url')!
	}
}

const parseStatusInfo = (mediaNode: BinaryNode): CatalogStatus => {
	const node = getBinaryNodeChild(mediaNode, 'status_info')
	return {
		status: getBinaryNodeChildString(node, 'status')!,
		canAppeal: getBinaryNodeChildString(node, 'can_appeal') === 'true'
	}
}



================================================
FILE: src/Utils/chat-utils.ts
================================================
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type {
	BaileysEventEmitter,
	Chat,
	ChatModification,
	ChatMutation,
	ChatUpdate,
	Contact,
	InitialAppStateSyncOptions,
	LastMessageList,
	LTHashState,
	WAPatchCreate,
	WAPatchName
} from '../Types'
import {
	type ChatLabelAssociation,
	LabelAssociationType,
	type MessageLabelAssociation
} from '../Types/LabelAssociation'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, jidNormalizedUser } from '../WABinary'
import { aesDecrypt, aesEncrypt, hkdf, hmacSign } from './crypto'
import { toNumber } from './generics'
import type { ILogger } from './logger'
import { LT_HASH_ANTI_TAMPERING } from './lt-hash'
import { downloadContentFromMessage } from './messages-media'

type FetchAppStateSyncKey = (keyId: string) => Promise<proto.Message.IAppStateSyncKeyData | null | undefined>

export type ChatMutationMap = { [index: string]: ChatMutation }

const mutationKeys = async (keydata: Uint8Array) => {
	const expanded = await hkdf(keydata, 160, { info: 'WhatsApp Mutation Keys' })
	return {
		indexKey: expanded.slice(0, 32),
		valueEncryptionKey: expanded.slice(32, 64),
		valueMacKey: expanded.slice(64, 96),
		snapshotMacKey: expanded.slice(96, 128),
		patchMacKey: expanded.slice(128, 160)
	}
}

const generateMac = (
	operation: proto.SyncdMutation.SyncdOperation,
	data: Buffer,
	keyId: Uint8Array | string,
	key: Buffer
) => {
	const getKeyData = () => {
		let r: number
		switch (operation) {
			case proto.SyncdMutation.SyncdOperation.SET:
				r = 0x01
				break
			case proto.SyncdMutation.SyncdOperation.REMOVE:
				r = 0x02
				break
		}

		const buff = Buffer.from([r])
		return Buffer.concat([buff, Buffer.from(keyId as string, 'base64')])
	}

	const keyData = getKeyData()

	const last = Buffer.alloc(8) // 8 bytes
	last.set([keyData.length], last.length - 1)

	const total = Buffer.concat([keyData, data, last])
	const hmac = hmacSign(total, key, 'sha512')

	return hmac.slice(0, 32)
}

const to64BitNetworkOrder = (e: number) => {
	const buff = Buffer.alloc(8)
	buff.writeUint32BE(e, 4)
	return buff
}

type Mac = { indexMac: Uint8Array; valueMac: Uint8Array; operation: proto.SyncdMutation.SyncdOperation }

const makeLtHashGenerator = ({ indexValueMap, hash }: Pick<LTHashState, 'hash' | 'indexValueMap'>) => {
	indexValueMap = { ...indexValueMap }
	const addBuffs: ArrayBuffer[] = []
	const subBuffs: ArrayBuffer[] = []

	return {
		mix: ({ indexMac, valueMac, operation }: Mac) => {
			const indexMacBase64 = Buffer.from(indexMac).toString('base64')
			const prevOp = indexValueMap[indexMacBase64]
			if (operation === proto.SyncdMutation.SyncdOperation.REMOVE) {
				if (!prevOp) {
					throw new Boom('tried remove, but no previous op', { data: { indexMac, valueMac } })
				}

				// remove from index value mac, since this mutation is erased
				delete indexValueMap[indexMacBase64]
			} else {
				addBuffs.push(new Uint8Array(valueMac).buffer)
				// add this index into the history map
				indexValueMap[indexMacBase64] = { valueMac }
			}

			if (prevOp) {
				subBuffs.push(new Uint8Array(prevOp.valueMac).buffer)
			}
		},
		finish: async () => {
			const hashArrayBuffer = new Uint8Array(hash).buffer
			const result = await LT_HASH_ANTI_TAMPERING.subtractThenAdd(hashArrayBuffer, addBuffs, subBuffs)
			const buffer = Buffer.from(result)

			return {
				hash: buffer,
				indexValueMap
			}
		}
	}
}

const generateSnapshotMac = (lthash: Uint8Array, version: number, name: WAPatchName, key: Buffer) => {
	const total = Buffer.concat([lthash, to64BitNetworkOrder(version), Buffer.from(name, 'utf-8')])
	return hmacSign(total, key, 'sha256')
}

const generatePatchMac = (
	snapshotMac: Uint8Array,
	valueMacs: Uint8Array[],
	version: number,
	type: WAPatchName,
	key: Buffer
) => {
	const total = Buffer.concat([snapshotMac, ...valueMacs, to64BitNetworkOrder(version), Buffer.from(type, 'utf-8')])
	return hmacSign(total, key)
}

export const newLTHashState = (): LTHashState => ({ version: 0, hash: Buffer.alloc(128), indexValueMap: {} })

export const encodeSyncdPatch = async (
	{ type, index, syncAction, apiVersion, operation }: WAPatchCreate,
	myAppStateKeyId: string,
	state: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey
) => {
	const key = !!myAppStateKeyId ? await getAppStateSyncKey(myAppStateKeyId) : undefined
	if (!key) {
		throw new Boom(`myAppStateKey ("${myAppStateKeyId}") not present`, { statusCode: 404 })
	}

	const encKeyId = Buffer.from(myAppStateKeyId, 'base64')

	state = { ...state, indexValueMap: { ...state.indexValueMap } }

	const indexBuffer = Buffer.from(JSON.stringify(index))
	const dataProto = proto.SyncActionData.fromObject({
		index: indexBuffer,
		value: syncAction,
		padding: new Uint8Array(0),
		version: apiVersion
	})
	const encoded = proto.SyncActionData.encode(dataProto).finish()

	const keyValue = await mutationKeys(key.keyData!)

	const encValue = aesEncrypt(encoded, keyValue.valueEncryptionKey)
	const valueMac = generateMac(operation, encValue, encKeyId, keyValue.valueMacKey)
	const indexMac = hmacSign(indexBuffer, keyValue.indexKey)

	// update LT hash
	const generator = makeLtHashGenerator(state)
	generator.mix({ indexMac, valueMac, operation })
	Object.assign(state, await generator.finish())

	state.version += 1

	const snapshotMac = generateSnapshotMac(state.hash, state.version, type, keyValue.snapshotMacKey)

	const patch: proto.ISyncdPatch = {
		patchMac: generatePatchMac(snapshotMac, [valueMac], state.version, type, keyValue.patchMacKey),
		snapshotMac: snapshotMac,
		keyId: { id: encKeyId },
		mutations: [
			{
				operation: operation,
				record: {
					index: {
						blob: indexMac
					},
					value: {
						blob: Buffer.concat([encValue, valueMac])
					},
					keyId: { id: encKeyId }
				}
			}
		]
	}

	const base64Index = indexMac.toString('base64')
	state.indexValueMap[base64Index] = { valueMac }

	return { patch, state }
}

export const decodeSyncdMutations = async (
	msgMutations: (proto.ISyncdMutation | proto.ISyncdRecord)[],
	initialState: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey,
	onMutation: (mutation: ChatMutation) => void,
	validateMacs: boolean
) => {
	const ltGenerator = makeLtHashGenerator(initialState)
	// indexKey used to HMAC sign record.index.blob
	// valueEncryptionKey used to AES-256-CBC encrypt record.value.blob[0:-32]
	// the remaining record.value.blob[0:-32] is the mac, it the HMAC sign of key.keyId + decoded proto data + length of bytes in keyId
	for (const msgMutation of msgMutations) {
		// if it's a syncdmutation, get the operation property
		// otherwise, if it's only a record -- it'll be a SET mutation
		const operation = 'operation' in msgMutation ? msgMutation.operation : proto.SyncdMutation.SyncdOperation.SET
		const record =
			'record' in msgMutation && !!msgMutation.record ? msgMutation.record : (msgMutation as proto.ISyncdRecord)

		const key = await getKey(record.keyId!.id!)
		const content = Buffer.from(record.value!.blob!)
		const encContent = content.slice(0, -32)
		const ogValueMac = content.slice(-32)
		if (validateMacs) {
			const contentHmac = generateMac(operation!, encContent, record.keyId!.id!, key.valueMacKey)
			if (Buffer.compare(contentHmac, ogValueMac) !== 0) {
				throw new Boom('HMAC content verification failed')
			}
		}

		const result = aesDecrypt(encContent, key.valueEncryptionKey)
		const syncAction = proto.SyncActionData.decode(result)

		if (validateMacs) {
			const hmac = hmacSign(syncAction.index!, key.indexKey)
			if (Buffer.compare(hmac, record.index!.blob!) !== 0) {
				throw new Boom('HMAC index verification failed')
			}
		}

		const indexStr = Buffer.from(syncAction.index!).toString()
		onMutation({ syncAction, index: JSON.parse(indexStr) })

		ltGenerator.mix({
			indexMac: record.index!.blob!,
			valueMac: ogValueMac,
			operation: operation!
		})
	}

	return await ltGenerator.finish()

	async function getKey(keyId: Uint8Array) {
		const base64Key = Buffer.from(keyId).toString('base64')
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) {
			throw new Boom(`failed to find key "${base64Key}" to decode mutation`, {
				statusCode: 404,
				data: { msgMutations }
			})
		}

		return mutationKeys(keyEnc.keyData!)
	}
}

export const decodeSyncdPatch = async (
	msg: proto.ISyncdPatch,
	name: WAPatchName,
	initialState: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey,
	onMutation: (mutation: ChatMutation) => void,
	validateMacs: boolean
) => {
	if (validateMacs) {
		const base64Key = Buffer.from(msg.keyId!.id!).toString('base64')
		const mainKeyObj = await getAppStateSyncKey(base64Key)
		if (!mainKeyObj) {
			throw new Boom(`failed to find key "${base64Key}" to decode patch`, { statusCode: 404, data: { msg } })
		}

		const mainKey = await mutationKeys(mainKeyObj.keyData!)
		const mutationmacs = msg.mutations!.map(mutation => mutation.record!.value!.blob!.slice(-32))

		const patchMac = generatePatchMac(
			msg.snapshotMac!,
			mutationmacs,
			toNumber(msg.version!.version),
			name,
			mainKey.patchMacKey
		)
		if (Buffer.compare(patchMac, msg.patchMac!) !== 0) {
			throw new Boom('Invalid patch mac')
		}
	}

	const result = await decodeSyncdMutations(msg.mutations!, initialState, getAppStateSyncKey, onMutation, validateMacs)
	return result
}

export const extractSyncdPatches = async (result: BinaryNode, options: RequestInit) => {
	const syncNode = getBinaryNodeChild(result, 'sync')
	const collectionNodes = getBinaryNodeChildren(syncNode, 'collection')

	const final = {} as {
		[T in WAPatchName]: { patches: proto.ISyncdPatch[]; hasMorePatches: boolean; snapshot?: proto.ISyncdSnapshot }
	}
	await Promise.all(
		collectionNodes.map(async collectionNode => {
			const patchesNode = getBinaryNodeChild(collectionNode, 'patches')

			const patches = getBinaryNodeChildren(patchesNode || collectionNode, 'patch')
			const snapshotNode = getBinaryNodeChild(collectionNode, 'snapshot')

			const syncds: proto.ISyncdPatch[] = []
			const name = collectionNode.attrs.name as WAPatchName

			const hasMorePatches = collectionNode.attrs.has_more_patches === 'true'

			let snapshot: proto.ISyncdSnapshot | undefined = undefined
			if (snapshotNode && !!snapshotNode.content) {
				if (!Buffer.isBuffer(snapshotNode)) {
					snapshotNode.content = Buffer.from(Object.values(snapshotNode.content))
				}

				const blobRef = proto.ExternalBlobReference.decode(snapshotNode.content as Buffer)
				const data = await downloadExternalBlob(blobRef, options)
				snapshot = proto.SyncdSnapshot.decode(data)
			}

			for (let { content } of patches) {
				if (content) {
					if (!Buffer.isBuffer(content)) {
						content = Buffer.from(Object.values(content))
					}

					const syncd = proto.SyncdPatch.decode(content as Uint8Array)
					if (!syncd.version) {
						syncd.version = { version: +collectionNode.attrs.version! + 1 }
					}

					syncds.push(syncd)
				}
			}

			final[name] = { patches: syncds, hasMorePatches, snapshot }
		})
	)

	return final
}

export const downloadExternalBlob = async (blob: proto.IExternalBlobReference, options: RequestInit) => {
	const stream = await downloadContentFromMessage(blob, 'md-app-state', { options })
	const bufferArray: Buffer[] = []
	for await (const chunk of stream) {
		bufferArray.push(chunk)
	}

	return Buffer.concat(bufferArray)
}

export const downloadExternalPatch = async (blob: proto.IExternalBlobReference, options: RequestInit) => {
	const buffer = await downloadExternalBlob(blob, options)
	const syncData = proto.SyncdMutations.decode(buffer)
	return syncData
}

export const decodeSyncdSnapshot = async (
	name: WAPatchName,
	snapshot: proto.ISyncdSnapshot,
	getAppStateSyncKey: FetchAppStateSyncKey,
	minimumVersionNumber: number | undefined,
	validateMacs = true
) => {
	const newState = newLTHashState()
	newState.version = toNumber(snapshot.version!.version)

	const mutationMap: ChatMutationMap = {}
	const areMutationsRequired = typeof minimumVersionNumber === 'undefined' || newState.version > minimumVersionNumber

	const { hash, indexValueMap } = await decodeSyncdMutations(
		snapshot.records!,
		newState,
		getAppStateSyncKey,
		areMutationsRequired
			? mutation => {
					const index = mutation.syncAction.index?.toString()
					mutationMap[index!] = mutation
				}
			: () => {},
		validateMacs
	)
	newState.hash = hash
	newState.indexValueMap = indexValueMap

	if (validateMacs) {
		const base64Key = Buffer.from(snapshot.keyId!.id!).toString('base64')
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) {
			throw new Boom(`failed to find key "${base64Key}" to decode mutation`)
		}

		const result = await mutationKeys(keyEnc.keyData!)
		const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
		if (Buffer.compare(snapshot.mac!, computedSnapshotMac) !== 0) {
			throw new Boom(`failed to verify LTHash at ${newState.version} of ${name} from snapshot`)
		}
	}

	return {
		state: newState,
		mutationMap
	}
}

export const decodePatches = async (
	name: WAPatchName,
	syncds: proto.ISyncdPatch[],
	initial: LTHashState,
	getAppStateSyncKey: FetchAppStateSyncKey,
	options: RequestInit,
	minimumVersionNumber?: number,
	logger?: ILogger,
	validateMacs = true
) => {
	const newState: LTHashState = {
		...initial,
		indexValueMap: { ...initial.indexValueMap }
	}

	const mutationMap: ChatMutationMap = {}

	for (const syncd of syncds) {
		const { version, keyId, snapshotMac } = syncd
		if (syncd.externalMutations) {
			logger?.trace({ name, version }, 'downloading external patch')
			const ref = await downloadExternalPatch(syncd.externalMutations, options)
			logger?.debug({ name, version, mutations: ref.mutations.length }, 'downloaded external patch')
			syncd.mutations?.push(...ref.mutations)
		}

		const patchVersion = toNumber(version!.version)

		newState.version = patchVersion
		const shouldMutate = typeof minimumVersionNumber === 'undefined' || patchVersion > minimumVersionNumber

		const decodeResult = await decodeSyncdPatch(
			syncd,
			name,
			newState,
			getAppStateSyncKey,
			shouldMutate
				? mutation => {
						const index = mutation.syncAction.index?.toString()
						mutationMap[index!] = mutation
					}
				: () => {},
			true
		)

		newState.hash = decodeResult.hash
		newState.indexValueMap = decodeResult.indexValueMap

		if (validateMacs) {
			const base64Key = Buffer.from(keyId!.id!).toString('base64')
			const keyEnc = await getAppStateSyncKey(base64Key)
			if (!keyEnc) {
				throw new Boom(`failed to find key "${base64Key}" to decode mutation`)
			}

			const result = await mutationKeys(keyEnc.keyData!)
			const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
			if (Buffer.compare(snapshotMac!, computedSnapshotMac) !== 0) {
				throw new Boom(`failed to verify LTHash at ${newState.version} of ${name}`)
			}
		}

		// clear memory used up by the mutations
		syncd.mutations = []
	}

	return { state: newState, mutationMap }
}

export const chatModificationToAppPatch = (mod: ChatModification, jid: string) => {
	const OP = proto.SyncdMutation.SyncdOperation
	const getMessageRange = (lastMessages: LastMessageList) => {
		let messageRange: proto.SyncActionValue.ISyncActionMessageRange
		if (Array.isArray(lastMessages)) {
			const lastMsg = lastMessages[lastMessages.length - 1]
			messageRange = {
				lastMessageTimestamp: lastMsg?.messageTimestamp,
				messages: lastMessages?.length
					? lastMessages.map(m => {
							if (!m.key?.id || !m.key?.remoteJid) {
								throw new Boom('Incomplete key', { statusCode: 400, data: m })
							}

							if (isJidGroup(m.key.remoteJid) && !m.key.fromMe && !m.key.participant) {
								throw new Boom('Expected not from me message to have participant', { statusCode: 400, data: m })
							}

							if (!m.messageTimestamp || !toNumber(m.messageTimestamp)) {
								throw new Boom('Missing timestamp in last message list', { statusCode: 400, data: m })
							}

							if (m.key.participant) {
								m.key.participant = jidNormalizedUser(m.key.participant)
							}

							return m
						})
					: undefined
			}
		} else {
			messageRange = lastMessages
		}

		return messageRange
	}

	let patch: WAPatchCreate
	if ('mute' in mod) {
		patch = {
			syncAction: {
				muteAction: {
					muted: !!mod.mute,
					muteEndTimestamp: mod.mute || undefined
				}
			},
			index: ['mute', jid],
			type: 'regular_high',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('archive' in mod) {
		patch = {
			syncAction: {
				archiveChatAction: {
					archived: !!mod.archive,
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['archive', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('markRead' in mod) {
		patch = {
			syncAction: {
				markChatAsReadAction: {
					read: mod.markRead,
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['markChatAsRead', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('deleteForMe' in mod) {
		const { timestamp, key, deleteMedia } = mod.deleteForMe
		patch = {
			syncAction: {
				deleteMessageForMeAction: {
					deleteMedia,
					messageTimestamp: timestamp
				}
			},
			index: ['deleteMessageForMe', jid, key.id!, key.fromMe ? '1' : '0', '0'],
			type: 'regular_high',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('clear' in mod) {
		patch = {
			syncAction: {
				clearChatAction: {
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['clearChat', jid, '1' /*the option here is 0 when keep starred messages is enabled*/, '0'],
			type: 'regular_high',
			apiVersion: 6,
			operation: OP.SET
		}
	} else if ('pin' in mod) {
		patch = {
			syncAction: {
				pinAction: {
					pinned: !!mod.pin
				}
			},
			index: ['pin_v1', jid],
			type: 'regular_low',
			apiVersion: 5,
			operation: OP.SET
		}
	} else if ('contact' in mod) {
		patch = {
			syncAction: {
				contactAction: mod.contact || {}
			},
			index: ['contact', jid],
			type: 'critical_unblock_low',
			apiVersion: 2,
			operation: mod.contact ? OP.SET : OP.REMOVE
		}
	} else if ('disableLinkPreviews' in mod) {
		patch = {
			syncAction: {
				privacySettingDisableLinkPreviewsAction: mod.disableLinkPreviews || {}
			},
			index: ['setting_disableLinkPreviews'],
			type: 'regular',
			apiVersion: 8,
			operation: OP.SET
		}
	} else if ('star' in mod) {
		const key = mod.star.messages[0]!
		patch = {
			syncAction: {
				starAction: {
					starred: !!mod.star.star
				}
			},
			index: ['star', jid, key.id, key.fromMe ? '1' : '0', '0'],
			type: 'regular_low',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('delete' in mod) {
		patch = {
			syncAction: {
				deleteChatAction: {
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['deleteChat', jid, '1'],
			type: 'regular_high',
			apiVersion: 6,
			operation: OP.SET
		}
	} else if ('pushNameSetting' in mod) {
		patch = {
			syncAction: {
				pushNameSetting: {
					name: mod.pushNameSetting
				}
			},
			index: ['setting_pushName'],
			type: 'critical_block',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('quickReply' in mod) {
		patch = {
			syncAction: {
				quickReplyAction: {
					count: 0,
					deleted: mod.quickReply.deleted || false,
					keywords: [],
					message: mod.quickReply.message || '',
					shortcut: mod.quickReply.shortcut || ''
				}
			},
			index: ['quick_reply', mod.quickReply.timestamp || String(Math.floor(Date.now() / 1000))],
			type: 'regular',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('addLabel' in mod) {
		patch = {
			syncAction: {
				labelEditAction: {
					name: mod.addLabel.name,
					color: mod.addLabel.color,
					predefinedId: mod.addLabel.predefinedId,
					deleted: mod.addLabel.deleted
				}
			},
			index: ['label_edit', mod.addLabel.id],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addChatLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: true
				}
			},
			index: [LabelAssociationType.Chat, mod.addChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeChatLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: false
				}
			},
			index: [LabelAssociationType.Chat, mod.removeChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addMessageLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: true
				}
			},
			index: [LabelAssociationType.Message, mod.addMessageLabel.labelId, jid, mod.addMessageLabel.messageId, '0', '0'],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeMessageLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: false
				}
			},
			index: [
				LabelAssociationType.Message,
				mod.removeMessageLabel.labelId,
				jid,
				mod.removeMessageLabel.messageId,
				'0',
				'0'
			],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else {
		throw new Boom('not supported')
	}

	patch.syncAction.timestamp = Date.now()

	return patch
}

export const processSyncAction = (
	syncAction: ChatMutation,
	ev: BaileysEventEmitter,
	me: Contact,
	initialSyncOpts?: InitialAppStateSyncOptions,
	logger?: ILogger
) => {
	const isInitialSync = !!initialSyncOpts
	const accountSettings = initialSyncOpts?.accountSettings

	logger?.trace({ syncAction, initialSync: !!initialSyncOpts }, 'processing sync action')

	const {
		syncAction: { value: action },
		index: [type, id, msgId, fromMe]
	} = syncAction

	if (action?.muteAction) {
		ev.emit('chats.update', [
			{
				id,
				muteEndTime: action.muteAction?.muted ? toNumber(action.muteAction.muteEndTimestamp) : null,
				conditional: getChatUpdateConditional(id!, undefined)
			}
		])
	} else if (action?.archiveChatAction || type === 'archive' || type === 'unarchive') {
		// okay so we've to do some annoying computation here
		// when we're initially syncing the app state
		// there are a few cases we need to handle
		// 1. if the account unarchiveChats setting is true
		//   a. if the chat is archived, and no further messages have been received -- simple, keep archived
		//   b. if the chat was archived, and the user received messages from the other person afterwards
		//		then the chat should be marked unarchved --
		//		we compare the timestamp of latest message from the other person to determine this
		// 2. if the account unarchiveChats setting is false -- then it doesn't matter,
		//	it'll always take an app state action to mark in unarchived -- which we'll get anyway
		const archiveAction = action?.archiveChatAction
		const isArchived = archiveAction ? archiveAction.archived : type === 'archive'
		// // basically we don't need to fire an "archive" update if the chat is being marked unarchvied
		// // this only applies for the initial sync
		// if(isInitialSync && !isArchived) {
		// 	isArchived = false
		// }

		const msgRange = !accountSettings?.unarchiveChats ? undefined : archiveAction?.messageRange
		// logger?.debug({ chat: id, syncAction }, 'message range archive')

		ev.emit('chats.update', [
			{
				id,
				archived: isArchived,
				conditional: getChatUpdateConditional(id!, msgRange)
			}
		])
	} else if (action?.markChatAsReadAction) {
		const markReadAction = action.markChatAsReadAction
		// basically we don't need to fire an "read" update if the chat is being marked as read
		// because the chat is read by default
		// this only applies for the initial sync
		const isNullUpdate = isInitialSync && markReadAction.read

		ev.emit('chats.update', [
			{
				id,
				unreadCount: isNullUpdate ? null : !!markReadAction?.read ? 0 : -1,
				conditional: getChatUpdateConditional(id!, markReadAction?.messageRange)
			}
		])
	} else if (action?.deleteMessageForMeAction || type === 'deleteMessageForMe') {
		ev.emit('messages.delete', {
			keys: [
				{
					remoteJid: id,
					id: msgId,
					fromMe: fromMe === '1'
				}
			]
		})
	} else if (action?.contactAction) {
		ev.emit('contacts.upsert', [
			{
				id: id!,
				name: action.contactAction.fullName!,
				lid: action.contactAction.lidJid || undefined,
				phoneNumber: action.contactAction.pnJid || undefined
			}
		])
	} else if (action?.pushNameSetting) {
		const name = action?.pushNameSetting?.name
		if (name && me?.name !== name) {
			ev.emit('creds.update', { me: { ...me, name } })
		}
	} else if (action?.pinAction) {
		ev.emit('chats.update', [
			{
				id,
				pinned: action.pinAction?.pinned ? toNumber(action.timestamp) : null,
				conditional: getChatUpdateConditional(id!, undefined)
			}
		])
	} else if (action?.unarchiveChatsSetting) {
		const unarchiveChats = !!action.unarchiveChatsSetting.unarchiveChats
		ev.emit('creds.update', { accountSettings: { unarchiveChats } })

		logger?.info(`archive setting updated => '${action.unarchiveChatsSetting.unarchiveChats}'`)
		if (accountSettings) {
			accountSettings.unarchiveChats = unarchiveChats
		}
	} else if (action?.starAction || type === 'star') {
		let starred = action?.starAction?.starred
		if (typeof starred !== 'boolean') {
			starred = syncAction.index[syncAction.index.length - 1] === '1'
		}

		ev.emit('messages.update', [
			{
				key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' },
				update: { starred }
			}
		])
	} else if (action?.deleteChatAction || type === 'deleteChat') {
		if (!isInitialSync) {
			ev.emit('chats.delete', [id!])
		}
	} else if (action?.labelEditAction) {
		const { name, color, deleted, predefinedId } = action.labelEditAction

		ev.emit('labels.edit', {
			id: id!,
			name: name!,
			color: color!,
			deleted: deleted!,
			predefinedId: predefinedId ? String(predefinedId) : undefined
		})
	} else if (action?.labelAssociationAction) {
		ev.emit('labels.association', {
			type: action.labelAssociationAction.labeled ? 'add' : 'remove',
			association:
				type === LabelAssociationType.Chat
					? ({
							type: LabelAssociationType.Chat,
							chatId: syncAction.index[2],
							labelId: syncAction.index[1]
						} as ChatLabelAssociation)
					: ({
							type: LabelAssociationType.Message,
							chatId: syncAction.index[2],
							messageId: syncAction.index[3],
							labelId: syncAction.index[1]
						} as MessageLabelAssociation)
		})
	} else {
		logger?.debug({ syncAction, id }, 'unprocessable update')
	}

	function getChatUpdateConditional(
		id: string,
		msgRange: proto.SyncActionValue.ISyncActionMessageRange | null | undefined
	): ChatUpdate['conditional'] {
		return isInitialSync
			? data => {
					const chat = data.historySets.chats[id] || data.chatUpserts[id]
					if (chat) {
						return msgRange ? isValidPatchBasedOnMessageRange(chat, msgRange) : true
					}
				}
			: undefined
	}

	function isValidPatchBasedOnMessageRange(
		chat: Chat,
		msgRange: proto.SyncActionValue.ISyncActionMessageRange | null | undefined
	) {
		const lastMsgTimestamp = Number(msgRange?.lastMessageTimestamp || msgRange?.lastSystemMessageTimestamp || 0)
		const chatLastMsgTimestamp = Number(chat?.lastMessageRecvTimestamp || 0)
		return lastMsgTimestamp >= chatLastMsgTimestamp
	}
}



================================================
FILE: src/Utils/crypto.ts
================================================
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import * as curve from 'libsignal/src/curve'
import { KEY_BUNDLE_TYPE } from '../Defaults'
import type { KeyPair } from '../Types'

// insure browser & node compatibility
const { subtle } = globalThis.crypto

/** prefix version byte to the pub keys, required for some curve crypto functions */
export const generateSignalPubKey = (pubKey: Uint8Array | Buffer) =>
	pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey])

export const Curve = {
	generateKeyPair: (): KeyPair => {
		const { pubKey, privKey } = curve.generateKeyPair()
		return {
			private: Buffer.from(privKey),
			// remove version byte
			public: Buffer.from(pubKey.slice(1))
		}
	},
	sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
		const shared = curve.calculateAgreement(generateSignalPubKey(publicKey), privateKey)
		return Buffer.from(shared)
	},
	sign: (privateKey: Uint8Array, buf: Uint8Array) => curve.calculateSignature(privateKey, buf),
	verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
		try {
			curve.verifySignature(generateSignalPubKey(pubKey), message, signature)
			return true
		} catch (error) {
			return false
		}
	}
}

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
	const preKey = Curve.generateKeyPair()
	const pubKey = generateSignalPubKey(preKey.public)

	const signature = Curve.sign(identityKeyPair.private, pubKey)

	return { keyPair: preKey, signature, keyId }
}

const GCM_TAG_LENGTH = 128 >> 3

/**
 * encrypt AES 256 GCM;
 * where the tag tag is suffixed to the ciphertext
 * */
export function aesEncryptGCM(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(additionalData)
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/**
 * decrypt AES 256 GCM;
 * where the auth tag is suffixed to the ciphertext
 * */
export function aesDecryptGCM(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array) {
	const decipher = createDecipheriv('aes-256-gcm', key, iv)
	// decrypt additional adata
	const enc = ciphertext.slice(0, ciphertext.length - GCM_TAG_LENGTH)
	const tag = ciphertext.slice(ciphertext.length - GCM_TAG_LENGTH)
	// set additional data
	decipher.setAAD(additionalData)
	decipher.setAuthTag(tag)

	return Buffer.concat([decipher.update(enc), decipher.final()])
}

export function aesEncryptCTR(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
	const cipher = createCipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function aesDecryptCTR(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) {
	const decipher = createDecipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** decrypt AES 256 CBC; where the IV is prefixed to the buffer */
export function aesDecrypt(buffer: Buffer, key: Buffer) {
	return aesDecryptWithIV(buffer.slice(16, buffer.length), key, buffer.slice(0, 16))
}

/** decrypt AES 256 CBC */
export function aesDecryptWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
	const aes = createDecipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([aes.update(buffer), aes.final()])
}

// encrypt AES 256 CBC; where a random IV is prefixed to the buffer
export function aesEncrypt(buffer: Buffer | Uint8Array, key: Buffer) {
	const IV = randomBytes(16)
	const aes = createCipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([IV, aes.update(buffer), aes.final()]) // prefix IV to the buffer
}

// encrypt AES 256 CBC with a given IV
export function aesEncrypWithIV(buffer: Buffer, key: Buffer, IV: Buffer) {
	const aes = createCipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([aes.update(buffer), aes.final()]) // prefix IV to the buffer
}

// sign HMAC using SHA 256
export function hmacSign(
	buffer: Buffer | Uint8Array,
	key: Buffer | Uint8Array,
	variant: 'sha256' | 'sha512' = 'sha256'
) {
	return createHmac(variant, key).update(buffer).digest()
}

export function sha256(buffer: Buffer) {
	return createHash('sha256').update(buffer).digest()
}

export function md5(buffer: Buffer) {
	return createHash('md5').update(buffer).digest()
}

// HKDF key expansion
export async function hkdf(
	buffer: Uint8Array | Buffer,
	expandedLength: number,
	info: { salt?: Buffer; info?: string }
): Promise<Buffer> {
	// Normalize to a Uint8Array whose underlying buffer is a regular ArrayBuffer (not ArrayBufferLike)
	// Cloning via new Uint8Array(...) guarantees the generic parameter is ArrayBuffer which satisfies WebCrypto types.
	const inputKeyMaterial = new Uint8Array(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))

	// Set default values if not provided
	const salt = info.salt ? new Uint8Array(info.salt) : new Uint8Array(0)
	const infoBytes = info.info ? new TextEncoder().encode(info.info) : new Uint8Array(0)

	// Import the input key material (cast to BufferSource to appease TS DOM typings)
	const importedKey = await subtle.importKey('raw', inputKeyMaterial as BufferSource, { name: 'HKDF' }, false, [
		'deriveBits'
	])

	// Derive bits using HKDF
	const derivedBits = await subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: salt,
			info: infoBytes
		},
		importedKey,
		expandedLength * 8 // Convert bytes to bits
	)

	return Buffer.from(derivedBits)
}

export async function derivePairingCodeKey(pairingCode: string, salt: Buffer): Promise<Buffer> {
	// Convert inputs to formats Web Crypto API can work with
	const encoder = new TextEncoder()
	const pairingCodeBuffer = encoder.encode(pairingCode)
	const saltBuffer = new Uint8Array(salt instanceof Uint8Array ? salt : new Uint8Array(salt))

	// Import the pairing code as key material
	const keyMaterial = await subtle.importKey('raw', pairingCodeBuffer as BufferSource, { name: 'PBKDF2' }, false, [
		'deriveBits'
	])

	// Derive bits using PBKDF2 with the same parameters
	// 2 << 16 = 131,072 iterations
	const derivedBits = await subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: saltBuffer as BufferSource,
			iterations: 2 << 16,
			hash: 'SHA-256'
		},
		keyMaterial,
		32 * 8 // 32 bytes * 8 = 256 bits
	)

	return Buffer.from(derivedBits)
}



================================================
FILE: src/Utils/decode-wa-message.ts
================================================
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { WAMessage, WAMessageKey } from '../Types'
import type { SignalRepositoryWithLIDStore } from '../Types/Signal'
import {
	areJidsSameUser,
	type BinaryNode,
	isHostedLidUser,
	isHostedPnUser,
	isJidBroadcast,
	isJidGroup,
	isJidMetaAI,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser
	//	transferDevice
} from '../WABinary'
import { unpadRandomMax16 } from './generics'
import type { ILogger } from './logger'

const getDecryptionJid = async (sender: string, repository: SignalRepositoryWithLIDStore): Promise<string> => {
	if (sender.includes('@lid')) {
		return sender
	}

	const mapped = await repository.lidMapping.getLIDForPN(sender)
	return mapped || sender
}

const storeMappingFromEnvelope = async (
	stanza: BinaryNode,
	sender: string,
	repository: SignalRepositoryWithLIDStore,
	decryptionJid: string,
	logger: ILogger
): Promise<void> => {
	const { senderAlt } = extractAddressingContext(stanza)

	if (senderAlt && isLidUser(senderAlt) && isPnUser(sender) && decryptionJid === sender) {
		try {
			await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
			await repository.migrateSession(sender, senderAlt)
			logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope')
		} catch (error) {
			logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping')
		}
	}
}

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'

// Retry configuration for failed decryption
export const DECRYPTION_RETRY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 100,
	sessionRecordErrors: ['No session record', 'SessionError: No session record']
}

export const NACK_REASONS = {
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}

type MessageType =
	| 'chat'
	| 'peer_broadcast'
	| 'other_broadcast'
	| 'group'
	| 'direct_peer_status'
	| 'other_status'
	| 'newsletter'

export const extractAddressingContext = (stanza: BinaryNode) => {
	let senderAlt: string | undefined
	let recipientAlt: string | undefined

	const sender = stanza.attrs.participant || stanza.attrs.from
	const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')

	if (addressingMode === 'lid') {
		// Message is LID-addressed: sender is LID, extract corresponding PN
		// without device data
		senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
		recipientAlt = stanza.attrs.recipient_pn
		// with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	} else {
		// Message is PN-addressed: sender is PN, extract corresponding LID
		// without device data
		senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
		recipientAlt = stanza.attrs.recipient_lid

		//with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	}

	return {
		addressingMode,
		senderAlt,
		recipientAlt
	}
}

/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string) {
	let msgType: MessageType
	let chatId: string
	let author: string
	let fromMe = false

	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant: string | undefined = stanza.attrs.participant
	const recipient: string | undefined = stanza.attrs.recipient

	const addressingContext = extractAddressingContext(stanza)

	const isMe = (jid: string) => areJidsSameUser(jid, meId)
	const isMeLid = (jid: string) => areJidsSameUser(jid, meLid)

	if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from)) {
		if (recipient && !isJidMetaAI(recipient)) {
			if (!isMe(from!) && !isMeLid(from!)) {
				throw new Boom('receipient present, but msg not from me', { data: stanza })
			}

			if (isMe(from!) || isMeLid(from!)) {
				fromMe = true
			}

			chatId = recipient
		} else {
			chatId = from!
		}

		msgType = 'chat'
		author = from!
	} else if (isJidGroup(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		if (isMe(participant) || isMeLid(participant)) {
			fromMe = true
		}

		msgType = 'group'
		author = participant
		chatId = from!
	} else if (isJidBroadcast(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		const isParticipantMe = isMe(participant)
		if (isJidStatusBroadcast(from!)) {
			msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
		} else {
			msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
		}

		fromMe = isParticipantMe
		chatId = from!
		author = participant
	} else if (isJidNewsletter(from)) {
		msgType = 'newsletter'
		chatId = from!
		author = from!

		if (isMe(from!) || isMeLid(from!)) {
			fromMe = true
		}
	} else {
		throw new Boom('Unknown message type', { data: stanza })
	}

	const pushname = stanza?.attrs?.notify

	const key: WAMessageKey = {
		remoteJid: chatId,
		remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
		fromMe,
		id: msgId,
		participant,
		participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
		addressingMode: addressingContext.addressingMode,
		...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
	}

	const fullMessage: WAMessage = {
		key,
		messageTimestamp: +stanza.attrs.t!,
		pushName: pushname,
		broadcast: isJidBroadcast(from)
	}

	if (key.fromMe) {
		fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
	}

	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId
	}
}

export const decryptMessageNode = (
	stanza: BinaryNode,
	meId: string,
	meLid: string,
	repository: SignalRepositoryWithLIDStore,
	logger: ILogger
) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				for (const { tag, attrs, content } of stanza.content) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = proto.VerifiedNameCertificate.decode(content)
						const details = proto.VerifiedNameCertificate.Details.decode(cert.details!)
						fullMessage.verifiedBizName = details.verifiedName
					}

					if (tag === 'unavailable' && attrs.type === 'view_once') {
						fullMessage.key.isViewOnce = true // TODO: remove from here and add a STUB TYPE
					}

					if (tag !== 'enc' && tag !== 'plaintext') {
						continue
					}

					if (!(content instanceof Uint8Array)) {
						continue
					}

					decryptables += 1

					let msgBuffer: Uint8Array

					const user = isPnUser(sender) ? sender : author // TODO: flaky logic

					const decryptionJid = await getDecryptionJid(user, repository)

					if (tag !== 'plaintext') {
						await storeMappingFromEnvelope(stanza, user, repository, decryptionJid, logger)
					}

					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type

						switch (e2eType) {
							case 'skmsg':
								msgBuffer = await repository.decryptGroupMessage({
									group: sender,
									authorJid: author,
									msg: content
								})
								break
							case 'pkmsg':
							case 'msg':
								msgBuffer = await repository.decryptMessage({
									jid: decryptionJid,
									type: e2eType,
									ciphertext: content
								})
								break
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}

						let msg: proto.IMessage = proto.Message.decode(
							e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer
						)
						msg = msg.deviceSentMessage?.message || msg
						if (msg.senderKeyDistributionMessage) {
							//eslint-disable-next-line max-depth
							try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.senderKeyDistributionMessage
								})
							} catch (err) {
								logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message')
							}
						}

						if (fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
					} catch (err: any) {
						const errorContext = {
							key: fullMessage.key,
							err,
							messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
							sender,
							author,
							isSessionRecordError: isSessionRecordError(err)
						}

						logger.error(errorContext, 'failed to decrypt message')

						fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message.toString()]
					}
				}
			}

			// if nothing was found to decrypt
			if (!decryptables) {
				fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}

/**
 * Utility function to check if an error is related to missing session record
 */
function isSessionRecordError(error: any): boolean {
	const errorMessage = error?.message || error?.toString() || ''
	return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(errorPattern => errorMessage.includes(errorPattern))
}



================================================
FILE: src/Utils/event-buffer.ts
================================================
import EventEmitter from 'events'
import type {
	BaileysEvent,
	BaileysEventEmitter,
	BaileysEventMap,
	BufferedEventData,
	Chat,
	ChatUpdate,
	Contact,
	WAMessage,
	WAMessageKey
} from '../Types'
import { WAMessageStatus } from '../Types'
import { trimUndefined } from './generics'
import type { ILogger } from './logger'
import { updateMessageWithReaction, updateMessageWithReceipt } from './messages'
import { isRealMessage, shouldIncrementChatUnread } from './process-message'

const BUFFERABLE_EVENT = [
	'messaging-history.set',
	'chats.upsert',
	'chats.update',
	'chats.delete',
	'contacts.upsert',
	'contacts.update',
	'messages.upsert',
	'messages.update',
	'messages.delete',
	'messages.reaction',
	'message-receipt.update',
	'groups.update'
] as const

type BufferableEvent = (typeof BUFFERABLE_EVENT)[number]

/**
 * A map that contains a list of all events that have been triggered
 *
 * Note, this can contain different type of events
 * this can make processing events extremely efficient -- since everything
 * can be done in a single transaction
 */
type BaileysEventData = Partial<BaileysEventMap>

const BUFFERABLE_EVENT_SET = new Set<BaileysEvent>(BUFFERABLE_EVENT)

type BaileysBufferableEventEmitter = BaileysEventEmitter & {
	/** Use to process events in a batch */
	process(handler: (events: BaileysEventData) => void | Promise<void>): () => void
	/**
	 * starts buffering events, call flush() to release them
	 * */
	buffer(): void
	/** buffers all events till the promise completes */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	createBufferedFunction<A extends any[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>
	/**
	 * flushes all buffered events
	 * @returns returns true if the flush actually happened, otherwise false
	 */
	flush(): boolean
	/** is there an ongoing buffer */
	isBuffering(): boolean
}

/**
 * The event buffer logically consolidates different events into a single event
 * making the data processing more efficient.
 */
export const makeEventBuffer = (logger: ILogger): BaileysBufferableEventEmitter => {
	const ev = new EventEmitter()
	const historyCache = new Set<string>()

	let data = makeBufferData()
	let isBuffering = false
	let bufferTimeout: NodeJS.Timeout | null = null
	let bufferCount = 0
	const MAX_HISTORY_CACHE_SIZE = 10000 // Limit the history cache size to prevent memory bloat
	const BUFFER_TIMEOUT_MS = 30000 // 30 seconds

	// take the generic event and fire it as a baileys event
	ev.on('event', (map: BaileysEventData) => {
		for (const event in map) {
			ev.emit(event, map[event as keyof BaileysEventMap])
		}
	})

	function buffer() {
		if (!isBuffering) {
			logger.debug('Event buffer activated')
			isBuffering = true
			bufferCount++

			// Auto-flush after a timeout to prevent infinite buffering
			if (bufferTimeout) {
				clearTimeout(bufferTimeout)
			}

			bufferTimeout = setTimeout(() => {
				if (isBuffering) {
					logger.warn('Buffer timeout reached, auto-flushing')
					flush()
				}
			}, BUFFER_TIMEOUT_MS)
		} else {
			bufferCount++
		}
	}

	function flush() {
		if (!isBuffering) {
			return false
		}

		logger.debug({ bufferCount }, 'Flushing event buffer')
		isBuffering = false
		bufferCount = 0

		// Clear timeout
		if (bufferTimeout) {
			clearTimeout(bufferTimeout)
			bufferTimeout = null
		}

		// Clear history cache if it exceeds the max size
		if (historyCache.size > MAX_HISTORY_CACHE_SIZE) {
			logger.debug({ cacheSize: historyCache.size }, 'Clearing history cache')
			historyCache.clear()
		}

		const newData = makeBufferData()
		const chatUpdates = Object.values(data.chatUpdates)
		let conditionalChatUpdatesLeft = 0
		for (const update of chatUpdates) {
			if (update.conditional) {
				conditionalChatUpdatesLeft += 1
				newData.chatUpdates[update.id!] = update
				delete data.chatUpdates[update.id!]
			}
		}

		const consolidatedData = consolidateEvents(data)
		if (Object.keys(consolidatedData).length) {
			ev.emit('event', consolidatedData)
		}

		data = newData

		logger.trace({ conditionalChatUpdatesLeft }, 'released buffered events')

		return true
	}

	return {
		process(handler) {
			const listener = (map: BaileysEventData) => {
				handler(map)
			}

			ev.on('event', listener)
			return () => {
				ev.off('event', listener)
			}
		},
		emit<T extends BaileysEvent>(event: BaileysEvent, evData: BaileysEventMap[T]) {
			if (isBuffering && BUFFERABLE_EVENT_SET.has(event)) {
				append(data, historyCache, event as BufferableEvent, evData, logger)
				return true
			}

			return ev.emit('event', { [event]: evData })
		},
		isBuffering() {
			return isBuffering
		},
		buffer,
		flush,
		createBufferedFunction(work) {
			return async (...args) => {
				buffer()
				try {
					const result = await work(...args)
					// If this is the only buffer, flush after a small delay
					if (bufferCount === 1) {
						setTimeout(() => {
							if (isBuffering && bufferCount === 1) {
								flush()
							}
						}, 100) // Small delay to allow nested buffers
					}

					return result
				} catch (error) {
					throw error
				} finally {
					bufferCount = Math.max(0, bufferCount - 1)
					if (bufferCount === 0) {
						// Auto-flush when no other buffers are active
						setTimeout(flush, 100)
					}
				}
			}
		},
		on: (...args) => ev.on(...args),
		off: (...args) => ev.off(...args),
		removeAllListeners: (...args) => ev.removeAllListeners(...args)
	}
}

const makeBufferData = (): BufferedEventData => {
	return {
		historySets: {
			chats: {},
			messages: {},
			contacts: {},
			isLatest: false,
			empty: true
		},
		chatUpserts: {},
		chatUpdates: {},
		chatDeletes: new Set(),
		contactUpserts: {},
		contactUpdates: {},
		messageUpserts: {},
		messageUpdates: {},
		messageReactions: {},
		messageDeletes: {},
		messageReceipts: {},
		groupUpdates: {}
	}
}

function append<E extends BufferableEvent>(
	data: BufferedEventData,
	historyCache: Set<string>,
	event: E,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	eventData: any,
	logger: ILogger
) {
	switch (event) {
		case 'messaging-history.set':
			for (const chat of eventData.chats as Chat[]) {
				const id = chat.id || ''
				const existingChat = data.historySets.chats[id]
				if (existingChat) {
					existingChat.endOfHistoryTransferType = chat.endOfHistoryTransferType
				}

				if (!existingChat && !historyCache.has(id)) {
					data.historySets.chats[id] = chat
					historyCache.add(id)

					absorbingChatUpdate(chat)
				}
			}

			for (const contact of eventData.contacts as Contact[]) {
				const existingContact = data.historySets.contacts[contact.id]
				if (existingContact) {
					Object.assign(existingContact, trimUndefined(contact))
				} else {
					const historyContactId = `c:${contact.id}`
					const hasAnyName = contact.notify || contact.name || contact.verifiedName
					if (!historyCache.has(historyContactId) || hasAnyName) {
						data.historySets.contacts[contact.id] = contact
						historyCache.add(historyContactId)
					}
				}
			}

			for (const message of eventData.messages as WAMessage[]) {
				const key = stringifyMessageKey(message.key)
				const existingMsg = data.historySets.messages[key]
				if (!existingMsg && !historyCache.has(key)) {
					data.historySets.messages[key] = message
					historyCache.add(key)
				}
			}

			data.historySets.empty = false
			data.historySets.syncType = eventData.syncType
			data.historySets.progress = eventData.progress
			data.historySets.peerDataRequestSessionId = eventData.peerDataRequestSessionId
			data.historySets.isLatest = eventData.isLatest || data.historySets.isLatest

			break
		case 'chats.upsert':
			for (const chat of eventData as Chat[]) {
				const id = chat.id || ''
				let upsert = data.chatUpserts[id]
				if (id && !upsert) {
					upsert = data.historySets.chats[id]
					if (upsert) {
						logger.debug({ chatId: id }, 'absorbed chat upsert in chat set')
					}
				}

				if (upsert) {
					upsert = concatChats(upsert, chat)
				} else {
					upsert = chat
					data.chatUpserts[id] = upsert
				}

				absorbingChatUpdate(upsert)

				if (data.chatDeletes.has(id)) {
					data.chatDeletes.delete(id)
				}
			}

			break
		case 'chats.update':
			for (const update of eventData as ChatUpdate[]) {
				const chatId = update.id!
				const conditionMatches = update.conditional ? update.conditional(data) : true
				if (conditionMatches) {
					delete update.conditional

					// if there is an existing upsert, merge the update into it
					const upsert = data.historySets.chats[chatId] || data.chatUpserts[chatId]
					if (upsert) {
						concatChats(upsert, update)
					} else {
						// merge the update into the existing update
						const chatUpdate = data.chatUpdates[chatId] || {}
						data.chatUpdates[chatId] = concatChats(chatUpdate, update)
					}
				} else if (conditionMatches === undefined) {
					// condition yet to be fulfilled
					data.chatUpdates[chatId] = update
				}
				// otherwise -- condition not met, update is invalid

				// if the chat has been updated
				// ignore any existing chat delete
				if (data.chatDeletes.has(chatId)) {
					data.chatDeletes.delete(chatId)
				}
			}

			break
		case 'chats.delete':
			for (const chatId of eventData as string[]) {
				if (!data.chatDeletes.has(chatId)) {
					data.chatDeletes.add(chatId)
				}

				// remove any prior updates & upserts
				if (data.chatUpdates[chatId]) {
					delete data.chatUpdates[chatId]
				}

				if (data.chatUpserts[chatId]) {
					delete data.chatUpserts[chatId]
				}

				if (data.historySets.chats[chatId]) {
					delete data.historySets.chats[chatId]
				}
			}

			break
		case 'contacts.upsert':
			for (const contact of eventData as Contact[]) {
				let upsert = data.contactUpserts[contact.id]
				if (!upsert) {
					upsert = data.historySets.contacts[contact.id]
					if (upsert) {
						logger.debug({ contactId: contact.id }, 'absorbed contact upsert in contact set')
					}
				}

				if (upsert) {
					upsert = Object.assign(upsert, trimUndefined(contact))
				} else {
					upsert = contact
					data.contactUpserts[contact.id] = upsert
				}

				if (data.contactUpdates[contact.id]) {
					upsert = Object.assign(data.contactUpdates[contact.id]!, trimUndefined(contact)) as Contact
					delete data.contactUpdates[contact.id]
				}
			}

			break
		case 'contacts.update':
			const contactUpdates = eventData as BaileysEventMap['contacts.update']
			for (const update of contactUpdates) {
				const id = update.id!
				// merge into prior upsert
				const upsert = data.historySets.contacts[id] || data.contactUpserts[id]
				if (upsert) {
					Object.assign(upsert, update)
				} else {
					// merge into prior update
					const contactUpdate = data.contactUpdates[id] || {}
					data.contactUpdates[id] = Object.assign(contactUpdate, update)
				}
			}

			break
		case 'messages.upsert':
			const { messages, type } = eventData as BaileysEventMap['messages.upsert']
			for (const message of messages) {
				const key = stringifyMessageKey(message.key)
				let existing = data.messageUpserts[key]?.message
				if (!existing) {
					existing = data.historySets.messages[key]
					if (existing) {
						logger.debug({ messageId: key }, 'absorbed message upsert in message set')
					}
				}

				if (existing) {
					message.messageTimestamp = existing.messageTimestamp
				}

				if (data.messageUpdates[key]) {
					logger.debug('absorbed prior message update in message upsert')
					Object.assign(message, data.messageUpdates[key].update)
					delete data.messageUpdates[key]
				}

				if (data.historySets.messages[key]) {
					data.historySets.messages[key] = message
				} else {
					data.messageUpserts[key] = {
						message,
						type: type === 'notify' || data.messageUpserts[key]?.type === 'notify' ? 'notify' : type
					}
				}
			}

			break
		case 'messages.update':
			const msgUpdates = eventData as BaileysEventMap['messages.update']
			for (const { key, update } of msgUpdates) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.historySets.messages[keyStr] || data.messageUpserts[keyStr]?.message
				if (existing) {
					Object.assign(existing, update)
					// if the message was received & read by us
					// the chat counter must have been incremented
					// so we need to decrement it
					if (update.status === WAMessageStatus.READ && !key.fromMe) {
						decrementChatReadCounterIfMsgDidUnread(existing)
					}
				} else {
					const msgUpdate = data.messageUpdates[keyStr] || { key, update: {} }
					Object.assign(msgUpdate.update, update)
					data.messageUpdates[keyStr] = msgUpdate
				}
			}

			break
		case 'messages.delete':
			const deleteData = eventData as BaileysEventMap['messages.delete']
			if ('keys' in deleteData) {
				const { keys } = deleteData
				for (const key of keys) {
					const keyStr = stringifyMessageKey(key)
					if (!data.messageDeletes[keyStr]) {
						data.messageDeletes[keyStr] = key
					}

					if (data.messageUpserts[keyStr]) {
						delete data.messageUpserts[keyStr]
					}

					if (data.messageUpdates[keyStr]) {
						delete data.messageUpdates[keyStr]
					}
				}
			} else {
				// TODO: add support
			}

			break
		case 'messages.reaction':
			const reactions = eventData as BaileysEventMap['messages.reaction']
			for (const { key, reaction } of reactions) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateMessageWithReaction(existing.message, reaction)
				} else {
					data.messageReactions[keyStr] = data.messageReactions[keyStr] || { key, reactions: [] }
					updateMessageWithReaction(data.messageReactions[keyStr], reaction)
				}
			}

			break
		case 'message-receipt.update':
			const receipts = eventData as BaileysEventMap['message-receipt.update']
			for (const { key, receipt } of receipts) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateMessageWithReceipt(existing.message, receipt)
				} else {
					data.messageReceipts[keyStr] = data.messageReceipts[keyStr] || { key, userReceipt: [] }
					updateMessageWithReceipt(data.messageReceipts[keyStr], receipt)
				}
			}

			break
		case 'groups.update':
			const groupUpdates = eventData as BaileysEventMap['groups.update']
			for (const update of groupUpdates) {
				const id = update.id!
				const groupUpdate = data.groupUpdates[id] || {}
				if (!data.groupUpdates[id]) {
					data.groupUpdates[id] = Object.assign(groupUpdate, update)
				}
			}

			break
		default:
			throw new Error(`"${event}" cannot be buffered`)
	}

	function absorbingChatUpdate(existing: Chat) {
		const chatId = existing.id || ''
		const update = data.chatUpdates[chatId]
		if (update) {
			const conditionMatches = update.conditional ? update.conditional(data) : true
			if (conditionMatches) {
				delete update.conditional
				logger.debug({ chatId }, 'absorbed chat update in existing chat')
				Object.assign(existing, concatChats(update as Chat, existing))
				delete data.chatUpdates[chatId]
			} else if (conditionMatches === false) {
				logger.debug({ chatId }, 'chat update condition fail, removing')
				delete data.chatUpdates[chatId]
			}
		}
	}

	function decrementChatReadCounterIfMsgDidUnread(message: WAMessage) {
		// decrement chat unread counter
		// if the message has already been marked read by us
		const chatId = message.key.remoteJid!
		const chat = data.chatUpdates[chatId] || data.chatUpserts[chatId]
		if (
			isRealMessage(message) &&
			shouldIncrementChatUnread(message) &&
			typeof chat?.unreadCount === 'number' &&
			chat.unreadCount > 0
		) {
			logger.debug({ chatId: chat.id }, 'decrementing chat counter')
			chat.unreadCount -= 1
			if (chat.unreadCount === 0) {
				delete chat.unreadCount
			}
		}
	}
}

function consolidateEvents(data: BufferedEventData) {
	const map: BaileysEventData = {}

	if (!data.historySets.empty) {
		map['messaging-history.set'] = {
			chats: Object.values(data.historySets.chats),
			messages: Object.values(data.historySets.messages),
			contacts: Object.values(data.historySets.contacts),
			syncType: data.historySets.syncType,
			progress: data.historySets.progress,
			isLatest: data.historySets.isLatest,
			peerDataRequestSessionId: data.historySets.peerDataRequestSessionId
		}
	}

	const chatUpsertList = Object.values(data.chatUpserts)
	if (chatUpsertList.length) {
		map['chats.upsert'] = chatUpsertList
	}

	const chatUpdateList = Object.values(data.chatUpdates)
	if (chatUpdateList.length) {
		map['chats.update'] = chatUpdateList
	}

	const chatDeleteList = Array.from(data.chatDeletes)
	if (chatDeleteList.length) {
		map['chats.delete'] = chatDeleteList
	}

	const messageUpsertList = Object.values(data.messageUpserts)
	if (messageUpsertList.length) {
		const type = messageUpsertList[0]!.type
		map['messages.upsert'] = {
			messages: messageUpsertList.map(m => m.message),
			type
		}
	}

	const messageUpdateList = Object.values(data.messageUpdates)
	if (messageUpdateList.length) {
		map['messages.update'] = messageUpdateList
	}

	const messageDeleteList = Object.values(data.messageDeletes)
	if (messageDeleteList.length) {
		map['messages.delete'] = { keys: messageDeleteList }
	}

	const messageReactionList = Object.values(data.messageReactions).flatMap(({ key, reactions }) =>
		reactions.flatMap(reaction => ({ key, reaction }))
	)
	if (messageReactionList.length) {
		map['messages.reaction'] = messageReactionList
	}

	const messageReceiptList = Object.values(data.messageReceipts).flatMap(({ key, userReceipt }) =>
		userReceipt.flatMap(receipt => ({ key, receipt }))
	)
	if (messageReceiptList.length) {
		map['message-receipt.update'] = messageReceiptList
	}

	const contactUpsertList = Object.values(data.contactUpserts)
	if (contactUpsertList.length) {
		map['contacts.upsert'] = contactUpsertList
	}

	const contactUpdateList = Object.values(data.contactUpdates)
	if (contactUpdateList.length) {
		map['contacts.update'] = contactUpdateList
	}

	const groupUpdateList = Object.values(data.groupUpdates)
	if (groupUpdateList.length) {
		map['groups.update'] = groupUpdateList
	}

	return map
}

function concatChats<C extends Partial<Chat>>(a: C, b: Partial<Chat>) {
	if (
		b.unreadCount === null && // neutralize unread counter
		a.unreadCount! < 0
	) {
		a.unreadCount = undefined
		b.unreadCount = undefined
	}

	if (typeof a.unreadCount === 'number' && typeof b.unreadCount === 'number') {
		b = { ...b }
		if (b.unreadCount! >= 0) {
			b.unreadCount = Math.max(b.unreadCount!, 0) + Math.max(a.unreadCount, 0)
		}
	}

	return Object.assign(a, b)
}

const stringifyMessageKey = (key: WAMessageKey) => `${key.remoteJid},${key.id},${key.fromMe ? '1' : '0'}`



================================================
FILE: src/Utils/generics.ts
================================================
import { Boom } from '@hapi/boom'
import { createHash, randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
const baileysVersion = [2, 3000, 1027934701]
import type {
	BaileysEventEmitter,
	BaileysEventMap,
	ConnectionState,
	WACallUpdateType,
	WAMessageKey,
	WAVersion
} from '../Types'
import { DisconnectReason } from '../Types'
import { type BinaryNode, getAllBinaryNodeChildren, jidDecode } from '../WABinary'
import { sha256 } from './crypto'

export const BufferJSON = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	replacer: (k: any, value: any) => {
		if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
			return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') }
		}

		return value
	},

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	reviver: (_: any, value: any) => {
		if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
			return Buffer.from(value.data, 'base64')
		}

		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const keys = Object.keys(value)
			if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)))) {
				const values = Object.values(value)
				if (values.every(v => typeof v === 'number')) {
					return Buffer.from(values)
				}
			}
		}

		return value
	}
}

export const getKeyAuthor = (key: WAMessageKey | undefined | null, meId = 'me') =>
	(key?.fromMe ? meId : key?.participant || key?.remoteJid) || ''

export const writeRandomPadMax16 = (msg: Uint8Array) => {
	const pad = randomBytes(1)
	const padLength = (pad[0]! & 0x0f) + 1

	return Buffer.concat([msg, Buffer.alloc(padLength, padLength)])
}

export const unpadRandomMax16 = (e: Uint8Array | Buffer) => {
	const t = new Uint8Array(e)
	if (0 === t.length) {
		throw new Error('unpadPkcs7 given empty bytes')
	}

	var r = t[t.length - 1]!
	if (r > t.length) {
		throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`)
	}

	return new Uint8Array(t.buffer, t.byteOffset, t.length - r)
}

// code is inspired by whatsmeow
export const generateParticipantHashV2 = (participants: string[]): string => {
	participants.sort()
	const sha256Hash = sha256(Buffer.from(participants.join(''))).toString('base64')
	return '2:' + sha256Hash.slice(0, 6)
}

export const encodeWAMessage = (message: proto.IMessage) => writeRandomPadMax16(proto.Message.encode(message).finish())

export const generateRegistrationId = (): number => {
	return Uint16Array.from(randomBytes(2))[0]! & 16383
}

export const encodeBigEndian = (e: number, t = 4) => {
	let r = e
	const a = new Uint8Array(t)
	for (let i = t - 1; i >= 0; i--) {
		a[i] = 255 & r
		r >>>= 8
	}

	return a
}

export const toNumber = (t: Long | number | null | undefined): number =>
	typeof t === 'object' && t ? ('toNumber' in t ? t.toNumber() : (t as Long).low) : t || 0

/** unix timestamp of a date in seconds */
export const unixTimestampSeconds = (date: Date = new Date()) => Math.floor(date.getTime() / 1000)

export type DebouncedTimeout = ReturnType<typeof debouncedTimeout>

export const debouncedTimeout = (intervalMs = 1000, task?: () => void) => {
	let timeout: NodeJS.Timeout | undefined
	return {
		start: (newIntervalMs?: number, newTask?: () => void) => {
			task = newTask || task
			intervalMs = newIntervalMs || intervalMs
			timeout && clearTimeout(timeout)
			timeout = setTimeout(() => task?.(), intervalMs)
		},
		cancel: () => {
			timeout && clearTimeout(timeout)
			timeout = undefined
		},
		setTask: (newTask: () => void) => (task = newTask),
		setInterval: (newInterval: number) => (intervalMs = newInterval)
	}
}

export const delay = (ms: number) => delayCancellable(ms).delay

export const delayCancellable = (ms: number) => {
	const stack = new Error().stack
	let timeout: NodeJS.Timeout
	let reject: (error: any) => void
	const delay: Promise<void> = new Promise((resolve, _reject) => {
		timeout = setTimeout(resolve, ms)
		reject = _reject
	})
	const cancel = () => {
		clearTimeout(timeout)
		reject(
			new Boom('Cancelled', {
				statusCode: 500,
				data: {
					stack
				}
			})
		)
	}

	return { delay, cancel }
}

export async function promiseTimeout<T>(
	ms: number | undefined,
	promise: (resolve: (v: T) => void, reject: (error: any) => void) => void
) {
	if (!ms) {
		return new Promise(promise)
	}

	const stack = new Error().stack
	// Create a promise that rejects in <ms> milliseconds
	const { delay, cancel } = delayCancellable(ms)
	const p = new Promise((resolve, reject) => {
		delay
			.then(() =>
				reject(
					new Boom('Timed Out', {
						statusCode: DisconnectReason.timedOut,
						data: {
							stack
						}
					})
				)
			)
			.catch(err => reject(err))

		promise(resolve, reject)
	}).finally(cancel)
	return p as Promise<T>
}

// inspired from whatsmeow code
// https://github.com/tulir/whatsmeow/blob/64bc969fbe78d31ae0dd443b8d4c80a5d026d07a/send.go#L42
export const generateMessageIDV2 = (userId?: string): string => {
	const data = Buffer.alloc(8 + 20 + 16)
	data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)))

	if (userId) {
		const id = jidDecode(userId)
		if (id?.user) {
			data.write(id.user, 8)
			data.write('@c.us', 8 + id.user.length)
		}
	}

	const random = randomBytes(16)
	random.copy(data, 28)

	const hash = createHash('sha256').update(data).digest()
	return '3EB0' + hash.toString('hex').toUpperCase().substring(0, 18)
}

// generate a random ID to attach to a message
export const generateMessageID = () => '3EB0' + randomBytes(18).toString('hex').toUpperCase()

export function bindWaitForEvent<T extends keyof BaileysEventMap>(ev: BaileysEventEmitter, event: T) {
	return async (check: (u: BaileysEventMap[T]) => Promise<boolean | undefined>, timeoutMs?: number) => {
		let listener: (item: BaileysEventMap[T]) => void
		let closeListener: (state: Partial<ConnectionState>) => void
		await promiseTimeout<void>(timeoutMs, (resolve, reject) => {
			closeListener = ({ connection, lastDisconnect }) => {
				if (connection === 'close') {
					reject(
						lastDisconnect?.error || new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
					)
				}
			}

			ev.on('connection.update', closeListener)
			listener = async update => {
				if (await check(update)) {
					resolve()
				}
			}

			ev.on(event, listener)
		}).finally(() => {
			ev.off(event, listener)
			ev.off('connection.update', closeListener)
		})
	}
}

export const bindWaitForConnectionUpdate = (ev: BaileysEventEmitter) => bindWaitForEvent(ev, 'connection.update')

/**
 * utility that fetches latest baileys version from the master branch.
 * Use to ensure your WA connection is always on the latest version
 */
export const fetchLatestBaileysVersion = async (options: RequestInit = {}) => {
	const URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts'
	try {
		const response = await fetch(URL, {
			dispatcher: options.dispatcher,
			method: 'GET',
			headers: options.headers
		})
		if (!response.ok) {
			throw new Boom(`Failed to fetch latest Baileys version: ${response.statusText}`, { statusCode: response.status })
		}

		const text = await response.text()
		// Extract version from line 7 (const version = [...])
		const lines = text.split('\n')
		const versionLine = lines[6] // Line 7 (0-indexed)
		const versionMatch = versionLine!.match(/const version = \[(\d+),\s*(\d+),\s*(\d+)\]/)

		if (versionMatch) {
			const version = [parseInt(versionMatch[1]!), parseInt(versionMatch[2]!), parseInt(versionMatch[3]!)] as WAVersion

			return {
				version,
				isLatest: true
			}
		} else {
			throw new Error('Could not parse version from Defaults/index.ts')
		}
	} catch (error) {
		return {
			version: baileysVersion as WAVersion,
			isLatest: false,
			error
		}
	}
}

/**
 * A utility that fetches the latest web version of whatsapp.
 * Use to ensure your WA connection is always on the latest version
 */
export const fetchLatestWaWebVersion = async (options: RequestInit = {}) => {
	try {
		// Absolute minimal headers required to bypass anti-bot detection
		const defaultHeaders = {
			'sec-fetch-site': 'none',
			'user-agent':
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
		}

		const headers = { ...defaultHeaders, ...options.headers }

		const response = await fetch('https://web.whatsapp.com/sw.js', {
			...options,
			method: 'GET',
			headers
		})

		if (!response.ok) {
			throw new Boom(`Failed to fetch sw.js: ${response.statusText}`, { statusCode: response.status })
		}

		const data = await response.text()

		const regex = /\\?"client_revision\\?":\s*(\d+)/
		const match = data.match(regex)

		if (!match?.[1]) {
			return {
				version: baileysVersion as WAVersion,
				isLatest: false,
				error: {
					message: 'Could not find client revision in the fetched content'
				}
			}
		}

		const clientRevision = match[1]

		return {
			version: [2, 3000, +clientRevision] as WAVersion,
			isLatest: true
		}
	} catch (error) {
		return {
			version: baileysVersion as WAVersion,
			isLatest: false,
			error
		}
	}
}

/** unique message tag prefix for MD clients */
export const generateMdTagPrefix = () => {
	const bytes = randomBytes(4)
	return `${bytes.readUInt16BE()}.${bytes.readUInt16BE(2)}-`
}

const STATUS_MAP: { [_: string]: proto.WebMessageInfo.Status } = {
	sender: proto.WebMessageInfo.Status.SERVER_ACK,
	played: proto.WebMessageInfo.Status.PLAYED,
	read: proto.WebMessageInfo.Status.READ,
	'read-self': proto.WebMessageInfo.Status.READ
}
/**
 * Given a type of receipt, returns what the new status of the message should be
 * @param type type from receipt
 */
export const getStatusFromReceiptType = (type: string | undefined) => {
	const status = STATUS_MAP[type!]
	if (typeof type === 'undefined') {
		return proto.WebMessageInfo.Status.DELIVERY_ACK
	}

	return status
}

const CODE_MAP: { [_: string]: DisconnectReason } = {
	conflict: DisconnectReason.connectionReplaced
}

/**
 * Stream errors generally provide a reason, map that to a baileys DisconnectReason
 * @param reason the string reason given, eg. "conflict"
 */
export const getErrorCodeFromStreamError = (node: BinaryNode) => {
	const [reasonNode] = getAllBinaryNodeChildren(node)
	let reason = reasonNode?.tag || 'unknown'
	const statusCode = +(node.attrs.code || CODE_MAP[reason] || DisconnectReason.badSession)

	if (statusCode === DisconnectReason.restartRequired) {
		reason = 'restart required'
	}

	return {
		reason,
		statusCode
	}
}

export const getCallStatusFromNode = ({ tag, attrs }: BinaryNode) => {
	let status: WACallUpdateType
	switch (tag) {
		case 'offer':
		case 'offer_notice':
			status = 'offer'
			break
		case 'terminate':
			if (attrs.reason === 'timeout') {
				status = 'timeout'
			} else {
				//fired when accepted/rejected/timeout/caller hangs up
				status = 'terminate'
			}

			break
		case 'reject':
			status = 'reject'
			break
		case 'accept':
			status = 'accept'
			break
		default:
			status = 'ringing'
			break
	}

	return status
}

const UNEXPECTED_SERVER_CODE_TEXT = 'Unexpected server response: '

export const getCodeFromWSError = (error: Error) => {
	let statusCode = 500
	if (error?.message?.includes(UNEXPECTED_SERVER_CODE_TEXT)) {
		const code = +error?.message.slice(UNEXPECTED_SERVER_CODE_TEXT.length)
		if (!Number.isNaN(code) && code >= 400) {
			statusCode = code
		}
	} else if (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(error as any)?.code?.startsWith('E') ||
		error?.message?.includes('timed out')
	) {
		// handle ETIMEOUT, ENOTFOUND etc
		statusCode = 408
	}

	return statusCode
}

/**
 * Is the given platform WA business
 * @param platform AuthenticationCreds.platform
 */
export const isWABusinessPlatform = (platform: string) => {
	return platform === 'smbi' || platform === 'smba'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function trimUndefined(obj: { [_: string]: any }) {
	for (const key in obj) {
		if (typeof obj[key] === 'undefined') {
			delete obj[key]
		}
	}

	return obj
}

const CROCKFORD_CHARACTERS = '123456789ABCDEFGHJKLMNPQRSTVWXYZ'

export function bytesToCrockford(buffer: Buffer): string {
	let value = 0
	let bitCount = 0
	const crockford: string[] = []

	for (const element of buffer) {
		value = (value << 8) | (element & 0xff)
		bitCount += 8

		while (bitCount >= 5) {
			crockford.push(CROCKFORD_CHARACTERS.charAt((value >>> (bitCount - 5)) & 31))
			bitCount -= 5
		}
	}

	if (bitCount > 0) {
		crockford.push(CROCKFORD_CHARACTERS.charAt((value << (5 - bitCount)) & 31))
	}

	return crockford.join('')
}

export function encodeNewsletterMessage(message: proto.IMessage): Uint8Array {
	return proto.Message.encode(message).finish()
}



================================================
FILE: src/Utils/history.ts
================================================
import { promisify } from 'util'
import { inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { Chat, Contact, WAMessage } from '../Types'
import { WAMessageStubType } from '../Types'
import { toNumber } from './generics'
import { normalizeMessageContent } from './messages'
import { downloadContentFromMessage } from './messages-media'

const inflatePromise = promisify(inflate)

export const downloadHistory = async (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => {
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	const bufferArray: Buffer[] = []
	for await (const chunk of stream) {
		bufferArray.push(chunk)
	}

	let buffer: Buffer = Buffer.concat(bufferArray)

	// decompress buffer
	buffer = await inflatePromise(buffer)

	const syncData = proto.HistorySync.decode(buffer)
	return syncData
}

export const processHistoryMessage = (item: proto.IHistorySync) => {
	const messages: WAMessage[] = []
	const contacts: Contact[] = []
	const chats: Chat[] = []

	switch (item.syncType) {
		case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case proto.HistorySync.HistorySyncType.RECENT:
		case proto.HistorySync.HistorySyncType.FULL:
		case proto.HistorySync.HistorySyncType.ON_DEMAND:
			for (const chat of item.conversations! as Chat[]) {
				contacts.push({
					id: chat.id!,
					name: chat.name || undefined,
					lid: chat.lidJid || undefined,
					phoneNumber: chat.pnJid || undefined
				})

				const msgs = chat.messages || []
				delete chat.messages

				for (const item of msgs) {
					const message = item.message! as WAMessage
					messages.push(message)

					if (!chat.messages?.length) {
						// keep only the most recent message in the chat array
						chat.messages = [{ message }]
					}

					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
						chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
					}

					if (
						(message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
							message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({
							id: message.key.participant || message.key.remoteJid!,
							verifiedName: message.messageStubParameters?.[0]
						})
					}
				}

				chats.push({ ...chat })
			}

			break
		case proto.HistorySync.HistorySyncType.PUSH_NAME:
			for (const c of item.pushnames!) {
				contacts.push({ id: c.id!, notify: c.pushname! })
			}

			break
	}

	return {
		chats,
		contacts,
		messages,
		syncType: item.syncType,
		progress: item.progress
	}
}

export const downloadAndProcessHistorySyncNotification = async (
	msg: proto.Message.IHistorySyncNotification,
	options: RequestInit
) => {
	const historyMsg = await downloadHistory(msg, options)
	return processHistoryMessage(historyMsg)
}

export const getHistoryMsg = (message: proto.IMessage) => {
	const normalizedContent = !!message ? normalizeMessageContent(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification!

	return anyHistoryMsg
}



================================================
FILE: src/Utils/index.ts
================================================
export * from './generics'
export * from './decode-wa-message'
export * from './messages'
export * from './messages-media'
export * from './validate-connection'
export * from './crypto'
export * from './signal'
export * from './noise-handler'
export * from './history'
export * from './chat-utils'
export * from './lt-hash'
export * from './auth-utils'
export * from './baileys-event-stream'
export * from './use-multi-file-auth-state'
export * from './link-preview'
export * from './event-buffer'
export * from './process-message'
export * from './message-retry-manager'
export * from './browser-utils'



================================================
FILE: src/Utils/link-preview.ts
================================================
import type { WAMediaUploadFunction, WAUrlInfo } from '../Types'
import type { ILogger } from './logger'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumb, getHttpStream } from './messages-media'

const THUMBNAIL_WIDTH_PX = 192

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async (url: string, { thumbnailWidth, fetchOpts }: URLGenerationOptions) => {
	const stream = await getHttpStream(url, fetchOpts)
	const result = await extractImageThumb(stream, thumbnailWidth)
	return result
}

export type URLGenerationOptions = {
	thumbnailWidth: number
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: HeadersInit
	}
	uploadImage?: WAMediaUploadFunction
	logger?: ILogger
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async (
	text: string,
	opts: URLGenerationOptions = {
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	}
): Promise<WAUrlInfo | undefined> => {
	try {
		// retries
		const retries = 0
		const maxRetry = 5

		const { getLinkPreview } = await import('link-preview-js')
		let previewLink = text
		if (!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		const info = await getLinkPreview(previewLink, {
			...opts.fetchOpts,
			followRedirects: 'follow',
			handleRedirects: (baseURL: string, forwardedURL: string) => {
				const urlObj = new URL(baseURL)
				const forwardedURLObj = new URL(forwardedURL)
				if (retries >= maxRetry) {
					return false
				}

				if (
					forwardedURLObj.hostname === urlObj.hostname ||
					forwardedURLObj.hostname === 'www.' + urlObj.hostname ||
					'www.' + forwardedURLObj.hostname === urlObj.hostname
				) {
					retries + 1
					return true
				} else {
					return false
				}
			},
			headers: opts.fetchOpts?.headers as {}
		})
		if (info && 'title' in info && info.title) {
			const [image] = info.images

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description,
				originalThumbnailUrl: image
			}

			if (opts.uploadImage) {
				const { imageMessage } = await prepareWAMessageMedia(
					{ image: { url: image! } },
					{
						upload: opts.uploadImage,
						mediaTypeOverride: 'thumbnail-link',
						options: opts.fetchOpts
					}
				)
				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined
				urlInfo.highQualityThumbnail = imageMessage || undefined
			} else {
				try {
					urlInfo.jpegThumbnail = image ? (await getCompressedJpegThumbnail(image, opts)).buffer : undefined
				} catch (error: any) {
					opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail')
				}
			}

			return urlInfo
		}
	} catch (error: any) {
		if (!error.message.includes('receive a valid')) {
			throw error
		}
	}
}



================================================
FILE: src/Utils/logger.ts
================================================
import P from 'pino'

export interface ILogger {
	level: string
	child(obj: Record<string, unknown>): ILogger
	trace(obj: unknown, msg?: string): void
	debug(obj: unknown, msg?: string): void
	info(obj: unknown, msg?: string): void
	warn(obj: unknown, msg?: string): void
	error(obj: unknown, msg?: string): void
}

export default P({ timestamp: () => `,"time":"${new Date().toJSON()}"` })



================================================
FILE: src/Utils/lt-hash.ts
================================================
import { hkdf } from './crypto'

/**
 * LT Hash is a summation based hash algorithm that maintains the integrity of a piece of data
 * over a series of mutations. You can add/remove mutations and it'll return a hash equal to
 * if the same series of mutations was made sequentially.
 */
const o = 128

class LTHash {
	salt: string

	constructor(e: string) {
		this.salt = e
	}

	async add(e: ArrayBuffer, t: ArrayBuffer[]): Promise<ArrayBuffer> {
		for (const item of t) {
			e = await this._addSingle(e, item)
		}

		return e
	}

	async subtract(e: ArrayBuffer, t: ArrayBuffer[]): Promise<ArrayBuffer> {
		for (const item of t) {
			e = await this._subtractSingle(e, item)
		}

		return e
	}

	async subtractThenAdd(e: ArrayBuffer, addList: ArrayBuffer[], subtractList: ArrayBuffer[]): Promise<ArrayBuffer> {
		const subtracted = await this.subtract(e, subtractList)
		return this.add(subtracted, addList)
	}

	private async _addSingle(e: ArrayBuffer, t: ArrayBuffer): Promise<ArrayBuffer> {
		const derived = new Uint8Array(await hkdf(Buffer.from(t), o, { info: this.salt })).buffer
		return this.performPointwiseWithOverflow(e, derived, (a, b) => a + b)
	}

	private async _subtractSingle(e: ArrayBuffer, t: ArrayBuffer): Promise<ArrayBuffer> {
		const derived = new Uint8Array(await hkdf(Buffer.from(t), o, { info: this.salt })).buffer
		return this.performPointwiseWithOverflow(e, derived, (a, b) => a - b)
	}

	private performPointwiseWithOverflow(
		e: ArrayBuffer,
		t: ArrayBuffer,
		op: (a: number, b: number) => number
	): ArrayBuffer {
		const n = new DataView(e)
		const i = new DataView(t)
		const out = new ArrayBuffer(n.byteLength)
		const s = new DataView(out)

		for (let offset = 0; offset < n.byteLength; offset += 2) {
			s.setUint16(offset, op(n.getUint16(offset, true), i.getUint16(offset, true)), true)
		}

		return out
	}
}
export const LT_HASH_ANTI_TAMPERING = new LTHash('WhatsApp Patch Integrity')



================================================
FILE: src/Utils/make-mutex.ts
================================================
export const makeMutex = () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let task = Promise.resolve() as Promise<any>

	let taskTimeout: NodeJS.Timeout | undefined

	return {
		mutex<T>(code: () => Promise<T> | T): Promise<T> {
			task = (async () => {
				// wait for the previous task to complete
				// if there is an error, we swallow so as to not block the queue
				try {
					await task
				} catch {}

				try {
					// execute the current task
					const result = await code()
					return result
				} finally {
					clearTimeout(taskTimeout)
				}
			})()
			// we replace the existing task, appending the new piece of execution to it
			// so the next task will have to wait for this one to finish
			return task
		}
	}
}

export type Mutex = ReturnType<typeof makeMutex>

export const makeKeyedMutex = () => {
	const map: { [id: string]: Mutex } = {}

	return {
		mutex<T>(key: string, task: () => Promise<T> | T): Promise<T> {
			if (!map[key]) {
				map[key] = makeMutex()
			}

			return map[key].mutex(task)
		}
	}
}



================================================
FILE: src/Utils/message-retry-manager.ts
================================================
import { LRUCache } from 'lru-cache'
import type { proto } from '../../WAProto/index.js'
import type { ILogger } from './logger'

/** Number of sent messages to cache in memory for handling retry receipts */
const RECENT_MESSAGES_SIZE = 512

/** Timeout for session recreation - 1 hour */
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000 // 1 hour in milliseconds
const PHONE_REQUEST_DELAY = 3000
export interface RecentMessageKey {
	to: string
	id: string
}

export interface RecentMessage {
	message: proto.IMessage
	timestamp: number
}

export interface SessionRecreateHistory {
	[jid: string]: number // timestamp
}

export interface RetryCounter {
	[messageId: string]: number
}

export interface PendingPhoneRequest {
	[messageId: string]: NodeJS.Timeout
}

export interface RetryStatistics {
	totalRetries: number
	successfulRetries: number
	failedRetries: number
	mediaRetries: number
	sessionRecreations: number
	phoneRequests: number
}

export class MessageRetryManager {
	private recentMessagesMap = new LRUCache<string, RecentMessage>({
		max: RECENT_MESSAGES_SIZE
	})
	private sessionRecreateHistory = new LRUCache<string, number>({
		ttl: RECREATE_SESSION_TIMEOUT * 2,
		ttlAutopurge: true
	})
	private retryCounters = new LRUCache<string, number>({
		ttl: 15 * 60 * 1000,
		ttlAutopurge: true,
		updateAgeOnGet: true
	}) // 15 minutes TTL
	private pendingPhoneRequests: PendingPhoneRequest = {}
	private readonly maxMsgRetryCount: number = 5
	private statistics: RetryStatistics = {
		totalRetries: 0,
		successfulRetries: 0,
		failedRetries: 0,
		mediaRetries: 0,
		sessionRecreations: 0,
		phoneRequests: 0
	}

	constructor(
		private logger: ILogger,
		maxMsgRetryCount: number
	) {
		this.maxMsgRetryCount = maxMsgRetryCount
	}

	/**
	 * Add a recent message to the cache for retry handling
	 */
	addRecentMessage(to: string, id: string, message: proto.IMessage): void {
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)

		// Add new message
		this.recentMessagesMap.set(keyStr, {
			message,
			timestamp: Date.now()
		})

		this.logger.debug(`Added message to retry cache: ${to}/${id}`)
	}

	/**
	 * Get a recent message from the cache
	 */
	getRecentMessage(to: string, id: string): RecentMessage | undefined {
		const key: RecentMessageKey = { to, id }
		const keyStr = this.keyToString(key)
		return this.recentMessagesMap.get(keyStr)
	}

	/**
	 * Check if a session should be recreated based on retry count and history
	 */
	shouldRecreateSession(jid: string, retryCount: number, hasSession: boolean): { reason: string; recreate: boolean } {
		// If we don't have a session, always recreate
		if (!hasSession) {
			this.sessionRecreateHistory.set(jid, Date.now())
			this.statistics.sessionRecreations++
			return {
				reason: "we don't have a Signal session with them",
				recreate: true
			}
		}

		// Only consider recreation if retry count > 1
		if (retryCount < 2) {
			return { reason: '', recreate: false }
		}

		const now = Date.now()
		const prevTime = this.sessionRecreateHistory.get(jid)

		// If no previous recreation or it's been more than an hour
		if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
			this.sessionRecreateHistory.set(jid, now)
			this.statistics.sessionRecreations++
			return {
				reason: 'retry count > 1 and over an hour since last recreation',
				recreate: true
			}
		}

		return { reason: '', recreate: false }
	}

	/**
	 * Increment retry counter for a message
	 */
	incrementRetryCount(messageId: string): number {
		this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1)
		this.statistics.totalRetries++
		return this.retryCounters.get(messageId)!
	}

	/**
	 * Get retry count for a message
	 */
	getRetryCount(messageId: string): number {
		return this.retryCounters.get(messageId) || 0
	}

	/**
	 * Check if message has exceeded maximum retry attempts
	 */
	hasExceededMaxRetries(messageId: string): boolean {
		return this.getRetryCount(messageId) >= this.maxMsgRetryCount
	}

	/**
	 * Mark retry as successful
	 */
	markRetrySuccess(messageId: string): void {
		this.statistics.successfulRetries++
		// Clean up retry counter for successful message
		this.retryCounters.delete(messageId)
		this.cancelPendingPhoneRequest(messageId)
	}

	/**
	 * Mark retry as failed
	 */
	markRetryFailed(messageId: string): void {
		this.statistics.failedRetries++
		this.retryCounters.delete(messageId)
	}

	/**
	 * Schedule a phone request with delay
	 */
	schedulePhoneRequest(messageId: string, callback: () => void, delay: number = PHONE_REQUEST_DELAY): void {
		// Cancel any existing request for this message
		this.cancelPendingPhoneRequest(messageId)

		this.pendingPhoneRequests[messageId] = setTimeout(() => {
			delete this.pendingPhoneRequests[messageId]
			this.statistics.phoneRequests++
			callback()
		}, delay)

		this.logger.debug(`Scheduled phone request for message ${messageId} with ${delay}ms delay`)
	}

	/**
	 * Cancel pending phone request
	 */
	cancelPendingPhoneRequest(messageId: string): void {
		const timeout = this.pendingPhoneRequests[messageId]
		if (timeout) {
			clearTimeout(timeout)
			delete this.pendingPhoneRequests[messageId]
			this.logger.debug(`Cancelled pending phone request for message ${messageId}`)
		}
	}

	private keyToString(key: RecentMessageKey): string {
		return `${key.to}:${key.id}`
	}
}



================================================
FILE: src/Utils/messages-media.ts
================================================
import { Boom } from '@hapi/boom'
import { exec } from 'child_process'
import * as Crypto from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs'
import type { IAudioMetadata } from 'music-metadata'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { URL } from 'url'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP, type MediaType } from '../Defaults'
import type {
	BaileysEventMap,
	DownloadableMessage,
	MediaConnInfo,
	MediaDecryptionKeyInfo,
	MessageType,
	SocketConfig,
	WAGenericMediaMessage,
	WAMediaUpload,
	WAMediaUploadFunction,
	WAMessageContent,
	WAMessageKey
} from '../Types'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto'
import { generateMessageIDV2 } from './generics'
import type { ILogger } from './logger'

const getTmpFilesDirectory = () => tmpdir()

const getImageProcessingLibrary = async () => {
	//@ts-ignore
	const [jimp, sharp] = await Promise.all([import('jimp').catch(() => {}), import('sharp').catch(() => {})])

	if (sharp) {
		return { sharp }
	}

	if (jimp) {
		return { jimp }
	}

	throw new Boom('No image processing library available')
}

export const hkdfInfoKey = (type: MediaType) => {
	const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type]
	return `WhatsApp ${hkdfInfo} Keys`
}

export const getRawMediaUploadData = async (media: WAMediaUpload, mediaType: MediaType, logger?: ILogger) => {
	const { stream } = await getStream(media)
	logger?.debug('got stream for raw upload')

	const hasher = Crypto.createHash('sha256')
	const filePath = join(tmpdir(), mediaType + generateMessageIDV2())
	const fileWriteStream = createWriteStream(filePath)

	let fileLength = 0
	try {
		for await (const data of stream) {
			fileLength += data.length
			hasher.update(data)
			if (!fileWriteStream.write(data)) {
				await once(fileWriteStream, 'drain')
			}
		}

		fileWriteStream.end()
		await once(fileWriteStream, 'finish')
		stream.destroy()
		const fileSha256 = hasher.digest()
		logger?.debug('hashed data for raw upload')
		return {
			filePath: filePath,
			fileSha256,
			fileLength
		}
	} catch (error) {
		fileWriteStream.destroy()
		stream.destroy()
		try {
			await fs.unlink(filePath)
		} catch {
			//
		}

		throw error
	}
}

/** generates all the keys required to encrypt/decrypt & sign a media message */
export async function getMediaKeys(
	buffer: Uint8Array | string | null | undefined,
	mediaType: MediaType
): Promise<MediaDecryptionKeyInfo> {
	if (!buffer) {
		throw new Boom('Cannot derive from empty media key')
	}

	if (typeof buffer === 'string') {
		buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
	}

	// expand using HKDF to 112 bytes, also pass in the relevant app info
	const expandedMediaKey = await hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
	return {
		iv: expandedMediaKey.slice(0, 16),
		cipherKey: expandedMediaKey.slice(16, 48),
		macKey: expandedMediaKey.slice(48, 80)
	}
}

/** Extracts video thumb using FFMPEG */
const extractVideoThumb = async (
	path: string,
	destPath: string,
	time: string,
	size: { width: number; height: number }
) =>
	new Promise<void>((resolve, reject) => {
		const cmd = `ffmpeg -ss ${time} -i ${path} -y -vf scale=${size.width}:-1 -vframes 1 -f image2 ${destPath}`
		exec(cmd, err => {
			if (err) {
				reject(err)
			} else {
				resolve()
			}
		})
	})

export const extractImageThumb = async (bufferOrFilePath: Readable | Buffer | string, width = 32) => {
	// TODO: Move entirely to sharp, removing jimp as it supports readable streams
	// This will have positive speed and performance impacts as well as minimizing RAM usage.
	if (bufferOrFilePath instanceof Readable) {
		bufferOrFilePath = await toBuffer(bufferOrFilePath)
	}

	const lib = await getImageProcessingLibrary()
	if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
		const img = lib.sharp.default(bufferOrFilePath)
		const dimensions = await img.metadata()

		const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer()
		return {
			buffer,
			original: {
				width: dimensions.width,
				height: dimensions.height
			}
		}
	} else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
		const jimp = await (lib.jimp.Jimp as any).read(bufferOrFilePath)
		const dimensions = {
			width: jimp.width,
			height: jimp.height
		}
		const buffer = await jimp
			.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR })
			.getBuffer('image/jpeg', { quality: 50 })
		return {
			buffer,
			original: dimensions
		}
	} else {
		throw new Boom('No image processing library available')
	}
}

export const encodeBase64EncodedStringForUpload = (b64: string) =>
	encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/\=+$/, ''))

export const generateProfilePicture = async (
	mediaUpload: WAMediaUpload,
	dimensions?: { width: number; height: number }
) => {
	let buffer: Buffer

	const { width: w = 640, height: h = 640 } = dimensions || {}

	if (Buffer.isBuffer(mediaUpload)) {
		buffer = mediaUpload
	} else {
		// Use getStream to handle all WAMediaUpload types (Buffer, Stream, URL)
		const { stream } = await getStream(mediaUpload)
		// Convert the resulting stream to a buffer
		buffer = await toBuffer(stream)
	}

	const lib = await getImageProcessingLibrary()
	let img: Promise<Buffer>
	if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
		img = lib.sharp
			.default(buffer)
			.resize(w, h)
			.jpeg({
				quality: 50
			})
			.toBuffer()
	} else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
		const jimp = await (lib.jimp.Jimp as any).read(buffer)
		const min = Math.min(jimp.width, jimp.height)
		const cropped = jimp.crop({ x: 0, y: 0, w: min, h: min })

		img = cropped.resize({ w, h, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 })
	} else {
		throw new Boom('No image processing library available')
	}

	return {
		img: await img
	}
}

/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = (message: WAMessageContent) => {
	const media = Object.values(message)[0] as WAGenericMediaMessage
	return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64')
}

export async function getAudioDuration(buffer: Buffer | string | Readable) {
	const musicMetadata = await import('music-metadata')
	let metadata: IAudioMetadata
	const options = {
		duration: true
	}
	if (Buffer.isBuffer(buffer)) {
		metadata = await musicMetadata.parseBuffer(buffer, undefined, options)
	} else if (typeof buffer === 'string') {
		metadata = await musicMetadata.parseFile(buffer, options)
	} else {
		metadata = await musicMetadata.parseStream(buffer, undefined, options)
	}

	return metadata.format.duration
}

/**
  referenced from and modifying https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/prepareAudioWaveform.ts
 */
export async function getAudioWaveform(buffer: Buffer | string | Readable, logger?: ILogger) {
	try {
		// @ts-ignore
		const { default: decoder } = await import('audio-decode')
		let audioData: Buffer
		if (Buffer.isBuffer(buffer)) {
			audioData = buffer
		} else if (typeof buffer === 'string') {
			const rStream = createReadStream(buffer)
			audioData = await toBuffer(rStream)
		} else {
			audioData = await toBuffer(buffer)
		}

		const audioBuffer = await decoder(audioData)

		const rawData = audioBuffer.getChannelData(0) // We only need to work with one channel of data
		const samples = 64 // Number of samples we want to have in our final data set
		const blockSize = Math.floor(rawData.length / samples) // the number of samples in each subdivision
		const filteredData: number[] = []
		for (let i = 0; i < samples; i++) {
			const blockStart = blockSize * i // the location of the first sample in the block
			let sum = 0
			for (let j = 0; j < blockSize; j++) {
				sum = sum + Math.abs(rawData[blockStart + j]) // find the sum of all the samples in the block
			}

			filteredData.push(sum / blockSize) // divide the sum by the block size to get the average
		}

		// This guarantees that the largest data point will be set to 1, and the rest of the data will scale proportionally.
		const multiplier = Math.pow(Math.max(...filteredData), -1)
		const normalizedData = filteredData.map(n => n * multiplier)

		// Generate waveform like WhatsApp
		const waveform = new Uint8Array(normalizedData.map(n => Math.floor(100 * n)))

		return waveform
	} catch (e) {
		logger?.debug('Failed to generate waveform: ' + e)
	}
}

export const toReadable = (buffer: Buffer) => {
	const readable = new Readable({ read: () => {} })
	readable.push(buffer)
	readable.push(null)
	return readable
}

export const toBuffer = async (stream: Readable) => {
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}

	stream.destroy()
	return Buffer.concat(chunks)
}

export const getStream = async (item: WAMediaUpload, opts?: RequestInit & { maxContentLength?: number }) => {
	if (Buffer.isBuffer(item)) {
		return { stream: toReadable(item), type: 'buffer' } as const
	}

	if ('stream' in item) {
		return { stream: item.stream, type: 'readable' } as const
	}

	const urlStr = item.url.toString()

	if (urlStr.startsWith('data:')) {
		const buffer = Buffer.from(urlStr.split(',')[1]!, 'base64')
		return { stream: toReadable(buffer), type: 'buffer' } as const
	}

	if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
		return { stream: await getHttpStream(item.url, opts), type: 'remote' } as const
	}

	return { stream: createReadStream(item.url), type: 'file' } as const
}

/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(
	file: string,
	mediaType: 'video' | 'image',
	options: {
		logger?: ILogger
	}
) {
	let thumbnail: string | undefined
	let originalImageDimensions: { width: number; height: number } | undefined
	if (mediaType === 'image') {
		const { buffer, original } = await extractImageThumb(file)
		thumbnail = buffer.toString('base64')
		if (original.width && original.height) {
			originalImageDimensions = {
				width: original.width,
				height: original.height
			}
		}
	} else if (mediaType === 'video') {
		const imgFilename = join(getTmpFilesDirectory(), generateMessageIDV2() + '.jpg')
		try {
			await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 })
			const buff = await fs.readFile(imgFilename)
			thumbnail = buff.toString('base64')

			await fs.unlink(imgFilename)
		} catch (err) {
			options.logger?.debug('could not generate video thumb: ' + err)
		}
	}

	return {
		thumbnail,
		originalImageDimensions
	}
}

export const getHttpStream = async (url: string | URL, options: RequestInit & { isStream?: true } = {}) => {
	const response = await fetch(url.toString(), {
		dispatcher: options.dispatcher,
		method: 'GET',
		headers: options.headers as HeadersInit
	})
	if (!response.ok) {
		throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } })
	}

	// @ts-ignore Node18+ Readable.fromWeb exists
	return Readable.fromWeb(response.body as any)
}

type EncryptedStreamOptions = {
	saveOriginalFileIfRequired?: boolean
	logger?: ILogger
	opts?: RequestInit
}

export const encryptedStream = async (
	media: WAMediaUpload,
	mediaType: MediaType,
	{ logger, saveOriginalFileIfRequired, opts }: EncryptedStreamOptions = {}
) => {
	const { stream, type } = await getStream(media, opts)

	logger?.debug('fetched media stream')

	const mediaKey = Crypto.randomBytes(32)
	const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType)

	const encFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-enc')
	const encFileWriteStream = createWriteStream(encFilePath)

	let originalFileStream: WriteStream | undefined
	let originalFilePath: string | undefined

	if (saveOriginalFileIfRequired) {
		originalFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-original')
		originalFileStream = createWriteStream(originalFilePath)
	}

	let fileLength = 0
	const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
	const hmac = Crypto.createHmac('sha256', macKey!).update(iv)
	const sha256Plain = Crypto.createHash('sha256')
	const sha256Enc = Crypto.createHash('sha256')

	const onChunk = (buff: Buffer) => {
		sha256Enc.update(buff)
		hmac.update(buff)
		encFileWriteStream.write(buff)
	}

	try {
		for await (const data of stream) {
			fileLength += data.length

			if (
				type === 'remote' &&
				(opts as any)?.maxContentLength &&
				fileLength + data.length > (opts as any).maxContentLength
			) {
				throw new Boom(`content length exceeded when encrypting "${type}"`, {
					data: { media, type }
				})
			}

			if (originalFileStream) {
				if (!originalFileStream.write(data)) {
					await once(originalFileStream, 'drain')
				}
			}

			sha256Plain.update(data)
			onChunk(aes.update(data))
		}

		onChunk(aes.final())

		const mac = hmac.digest().slice(0, 10)
		sha256Enc.update(mac)

		const fileSha256 = sha256Plain.digest()
		const fileEncSha256 = sha256Enc.digest()

		encFileWriteStream.write(mac)

		encFileWriteStream.end()
		originalFileStream?.end?.()
		stream.destroy()

		logger?.debug('encrypted data successfully')

		return {
			mediaKey,
			originalFilePath,
			encFilePath,
			mac,
			fileEncSha256,
			fileSha256,
			fileLength
		}
	} catch (error) {
		// destroy all streams with error
		encFileWriteStream.destroy()
		originalFileStream?.destroy?.()
		aes.destroy()
		hmac.destroy()
		sha256Plain.destroy()
		sha256Enc.destroy()
		stream.destroy()

		try {
			await fs.unlink(encFilePath)
			if (originalFilePath) {
				await fs.unlink(originalFilePath)
			}
		} catch (err) {
			logger?.error({ err }, 'failed deleting tmp files')
		}

		throw error
	}
}

const DEF_HOST = 'mmg.whatsapp.net'
const AES_CHUNK_SIZE = 16

const toSmallestChunkSize = (num: number) => {
	return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE
}

export type MediaDownloadOptions = {
	startByte?: number
	endByte?: number
	options?: RequestInit
}

export const getUrlFromDirectPath = (directPath: string) => `https://${DEF_HOST}${directPath}`

export const downloadContentFromMessage = async (
	{ mediaKey, directPath, url }: DownloadableMessage,
	type: MediaType,
	opts: MediaDownloadOptions = {}
) => {
	const isValidMediaUrl = url?.startsWith('https://mmg.whatsapp.net/')
	const downloadUrl = isValidMediaUrl ? url : getUrlFromDirectPath(directPath!)
	if (!downloadUrl) {
		throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 })
	}

	const keys = await getMediaKeys(mediaKey, type)

	return downloadEncryptedContent(downloadUrl, keys, opts)
}

/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
export const downloadEncryptedContent = async (
	downloadUrl: string,
	{ cipherKey, iv }: MediaDecryptionKeyInfo,
	{ startByte, endByte, options }: MediaDownloadOptions = {}
) => {
	let bytesFetched = 0
	let startChunk = 0
	let firstBlockIsIV = false
	// if a start byte is specified -- then we need to fetch the previous chunk as that will form the IV
	if (startByte) {
		const chunk = toSmallestChunkSize(startByte || 0)
		if (chunk) {
			startChunk = chunk - AES_CHUNK_SIZE
			bytesFetched = chunk

			firstBlockIsIV = true
		}
	}

	const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined

	const headersInit = options?.headers ? options.headers : undefined
	const headers: Record<string, string> = {
		...(headersInit
			? Array.isArray(headersInit)
				? Object.fromEntries(headersInit)
				: (headersInit as Record<string, string>)
			: {}),
		Origin: DEFAULT_ORIGIN
	}
	if (startChunk || endChunk) {
		headers.Range = `bytes=${startChunk}-`
		if (endChunk) {
			headers.Range += endChunk
		}
	}

	// download the message
	const fetched = await getHttpStream(downloadUrl, {
		...(options || {}),
		headers
	})

	let remainingBytes = Buffer.from([])

	let aes: Crypto.Decipher

	const pushBytes = (bytes: Buffer, push: (bytes: Buffer) => void) => {
		if (startByte || endByte) {
			const start = bytesFetched >= startByte! ? undefined : Math.max(startByte! - bytesFetched, 0)
			const end = bytesFetched + bytes.length < endByte! ? undefined : Math.max(endByte! - bytesFetched, 0)

			push(bytes.slice(start, end))

			bytesFetched += bytes.length
		} else {
			push(bytes)
		}
	}

	const output = new Transform({
		transform(chunk, _, callback) {
			let data = Buffer.concat([remainingBytes, chunk])

			const decryptLength = toSmallestChunkSize(data.length)
			remainingBytes = data.slice(decryptLength)
			data = data.slice(0, decryptLength)

			if (!aes) {
				let ivValue = iv
				if (firstBlockIsIV) {
					ivValue = data.slice(0, AES_CHUNK_SIZE)
					data = data.slice(AES_CHUNK_SIZE)
				}

				aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue)
				// if an end byte that is not EOF is specified
				// stop auto padding (PKCS7) -- otherwise throws an error for decryption
				if (endByte) {
					aes.setAutoPadding(false)
				}
			}

			try {
				pushBytes(aes.update(data), b => this.push(b))
				callback()
			} catch (error: any) {
				callback(error)
			}
		},
		final(callback) {
			try {
				pushBytes(aes.final(), b => this.push(b))
				callback()
			} catch (error: any) {
				callback(error)
			}
		}
	})
	return fetched.pipe(output, { end: true })
}

export function extensionForMediaMessage(message: WAMessageContent) {
	const getExtension = (mimetype: string) => mimetype.split(';')[0]?.split('/')[1]
	const type = Object.keys(message)[0] as Exclude<MessageType, 'toJSON'>
	let extension: string
	if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
		extension = '.jpeg'
	} else {
		const messageContent = message[type] as WAGenericMediaMessage
		extension = getExtension(messageContent.mimetype!)!
	}

	return extension
}

export const getWAUploadToServer = (
	{ customUploadHosts, fetchAgent, logger, options }: SocketConfig,
	refreshMediaConn: (force: boolean) => Promise<MediaConnInfo>
): WAMediaUploadFunction => {
	return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {
		// send a query JSON to obtain the url & auth token to upload our media
		let uploadInfo = await refreshMediaConn(false)

		let urls: { mediaUrl: string; directPath: string; meta_hmac?: string; ts?: number; fbid?: number } | undefined
		const hosts = [...customUploadHosts, ...uploadInfo.hosts]

		fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64)

		for (const { hostname } of hosts) {
			logger.debug(`uploading to "${hostname}"`)

			const auth = encodeURIComponent(uploadInfo.auth) // the auth token
			const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let result: any
			try {
				const stream = createReadStream(filePath)
				const response = await fetch(url, {
					dispatcher: fetchAgent,
					method: 'POST',
					body: stream as any,
					headers: {
						...(() => {
							const hdrs = options?.headers
							if (!hdrs) return {}
							return Array.isArray(hdrs) ? Object.fromEntries(hdrs) : (hdrs as Record<string, string>)
						})(),
						'Content-Type': 'application/octet-stream',
						Origin: DEFAULT_ORIGIN
					},
					duplex: 'half',
					// Note: custom agents/proxy require undici Agent; omitted here.
					signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
				})
				let parsed: any = undefined
				try {
					parsed = await response.json()
				} catch {
					parsed = undefined
				}

				result = parsed

				if (result?.url || result?.directPath) {
					urls = {
						mediaUrl: result.url,
						directPath: result.direct_path,
						meta_hmac: result.meta_hmac,
						fbid: result.fbid,
						ts: result.ts
					}
					break
				} else {
					uploadInfo = await refreshMediaConn(true)
					throw new Error(`upload failed, reason: ${JSON.stringify(result)}`)
				}
			} catch (error: any) {
				const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname
				logger.warn(
					{ trace: error?.stack, uploadResult: result },
					`Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`
				)
			}
		}

		if (!urls) {
			throw new Boom('Media upload failed on all hosts', { statusCode: 500 })
		}

		return urls
	}
}

const getMediaRetryKey = (mediaKey: Buffer | Uint8Array) => {
	return hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
}

/**
 * Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL
 */
export const encryptMediaRetryRequest = async (key: WAMessageKey, mediaKey: Buffer | Uint8Array, meId: string) => {
	const recp: proto.IServerErrorReceipt = { stanzaId: key.id }
	const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish()

	const iv = Crypto.randomBytes(12)
	const retryKey = await getMediaRetryKey(mediaKey)
	const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id!))

	const req: BinaryNode = {
		tag: 'receipt',
		attrs: {
			id: key.id!,
			to: jidNormalizedUser(meId),
			type: 'server-error'
		},
		content: [
			// this encrypt node is actually pretty useless
			// the media is returned even without this node
			// keeping it here to maintain parity with WA Web
			{
				tag: 'encrypt',
				attrs: {},
				content: [
					{ tag: 'enc_p', attrs: {}, content: ciphertext },
					{ tag: 'enc_iv', attrs: {}, content: iv }
				]
			},
			{
				tag: 'rmr',
				attrs: {
					jid: key.remoteJid!,
					from_me: (!!key.fromMe).toString(),
					// @ts-ignore
					participant: key.participant || undefined
				}
			}
		]
	}

	return req
}

export const decodeMediaRetryNode = (node: BinaryNode) => {
	const rmrNode = getBinaryNodeChild(node, 'rmr')!

	const event: BaileysEventMap['messages.media-update'][number] = {
		key: {
			id: node.attrs.id,
			remoteJid: rmrNode.attrs.jid,
			fromMe: rmrNode.attrs.from_me === 'true',
			participant: rmrNode.attrs.participant
		}
	}

	const errorNode = getBinaryNodeChild(node, 'error')
	if (errorNode) {
		const errorCode = +errorNode.attrs.code!
		event.error = new Boom(`Failed to re-upload media (${errorCode})`, {
			data: errorNode.attrs,
			statusCode: getStatusCodeForMediaRetry(errorCode)
		})
	} else {
		const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt')
		const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p')
		const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv')
		if (ciphertext && iv) {
			event.media = { ciphertext, iv }
		} else {
			event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 })
		}
	}

	return event
}

export const decryptMediaRetryData = async (
	{ ciphertext, iv }: { ciphertext: Uint8Array; iv: Uint8Array },
	mediaKey: Uint8Array,
	msgId: string
) => {
	const retryKey = await getMediaRetryKey(mediaKey)
	const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId))
	return proto.MediaRetryNotification.decode(plaintext)
}

export const getStatusCodeForMediaRetry = (code: number) =>
	MEDIA_RETRY_STATUS_MAP[code as proto.MediaRetryNotification.ResultType]

const MEDIA_RETRY_STATUS_MAP = {
	[proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
	[proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
	[proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
	[proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
} as const



================================================
FILE: src/Utils/messages.ts
================================================
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { type Transform } from 'stream'
import { proto } from '../../WAProto/index.js'
import {
	CALL_AUDIO_PREFIX,
	CALL_VIDEO_PREFIX,
	MEDIA_KEYS,
	type MediaType,
	URL_REGEX,
	WA_DEFAULT_EPHEMERAL
} from '../Defaults'
import type {
	AnyMediaMessageContent,
	AnyMessageContent,
	DownloadableMessage,
	MessageContentGenerationOptions,
	MessageGenerationOptions,
	MessageGenerationOptionsFromContent,
	MessageUserReceipt,
	MessageWithContextInfo,
	WAMediaUpload,
	WAMessage,
	WAMessageContent,
	WAMessageKey,
	WATextMessage
} from '../Types'
import { WAMessageStatus, WAProto } from '../Types'
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary'
import { sha256 } from './crypto'
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics'
import type { ILogger } from './logger'
import {
	downloadContentFromMessage,
	encryptedStream,
	generateThumbnail,
	getAudioDuration,
	getAudioWaveform,
	getRawMediaUploadData,
	type MediaDownloadOptions
} from './messages-media'

type MediaUploadData = {
	media: WAMediaUpload
	caption?: string
	ptt?: boolean
	ptv?: boolean
	seconds?: number
	gifPlayback?: boolean
	fileName?: string
	jpegThumbnail?: string
	mimetype?: string
	width?: number
	height?: number
	waveform?: Uint8Array
	backgroundArgb?: number
}

const MIMETYPE_MAP: { [T in MediaType]?: string } = {
	image: 'image/jpeg',
	video: 'video/mp4',
	document: 'application/pdf',
	audio: 'audio/ogg; codecs=opus',
	sticker: 'image/webp',
	'product-catalog-image': 'image/jpeg'
}

const MessageTypeProto = {
	image: WAProto.Message.ImageMessage,
	video: WAProto.Message.VideoMessage,
	audio: WAProto.Message.AudioMessage,
	sticker: WAProto.Message.StickerMessage,
	document: WAProto.Message.DocumentMessage
} as const

/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export const extractUrlFromText = (text: string) => text.match(URL_REGEX)?.[0]

export const generateLinkPreviewIfRequired = async (
	text: string,
	getUrlInfo: MessageGenerationOptions['getUrlInfo'],
	logger: MessageGenerationOptions['logger']
) => {
	const url = extractUrlFromText(text)
	if (!!getUrlInfo && url) {
		try {
			const urlInfo = await getUrlInfo(url)
			return urlInfo
		} catch (error: any) {
			// ignore if fails
			logger?.warn({ trace: error.stack }, 'url generation failed')
		}
	}
}

const assertColor = async (color: any) => {
	let assertedColor
	if (typeof color === 'number') {
		assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1
	} else {
		let hex = color.trim().replace('#', '')
		if (hex.length <= 6) {
			hex = 'FF' + hex.padStart(6, '0')
		}

		assertedColor = parseInt(hex, 16)
		return assertedColor
	}
}

export const prepareWAMessageMedia = async (
	message: AnyMediaMessageContent,
	options: MessageContentGenerationOptions
) => {
	const logger = options.logger

	let mediaType: (typeof MEDIA_KEYS)[number] | undefined
	for (const key of MEDIA_KEYS) {
		if (key in message) {
			mediaType = key
		}
	}

	if (!mediaType) {
		throw new Boom('Invalid media type', { statusCode: 400 })
	}

	const uploadData: MediaUploadData = {
		...message,
		media: (message as any)[mediaType]
	}
	delete (uploadData as any)[mediaType]
	// check if cacheable + generate cache key
	const cacheableKey =
		typeof uploadData.media === 'object' &&
		'url' in uploadData.media &&
		!!uploadData.media.url &&
		!!options.mediaCache &&
		mediaType + ':' + uploadData.media.url.toString()

	if (mediaType === 'document' && !uploadData.fileName) {
		uploadData.fileName = 'file'
	}

	if (!uploadData.mimetype) {
		uploadData.mimetype = MIMETYPE_MAP[mediaType]
	}

	if (cacheableKey) {
		const mediaBuff = await options.mediaCache!.get<Buffer>(cacheableKey)
		if (mediaBuff) {
			logger?.debug({ cacheableKey }, 'got media cache hit')

			const obj = proto.Message.decode(mediaBuff)
			const key = `${mediaType}Message`

			Object.assign(obj[key as keyof proto.Message]!, { ...uploadData, media: undefined })

			return obj
		}
	}

	const isNewsletter = !!options.jid && isJidNewsletter(options.jid)
	if (isNewsletter) {
		logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter')
		const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(
			uploadData.media,
			options.mediaTypeOverride || mediaType,
			logger
		)

		const fileSha256B64 = fileSha256.toString('base64')
		const { mediaUrl, directPath } = await options.upload(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType: mediaType,
			timeoutMs: options.mediaUploadTimeoutMs
		})

		await fs.unlink(filePath)

		const obj = WAProto.Message.fromObject({
			// todo: add more support here
			[`${mediaType}Message`]: (MessageTypeProto as any)[mediaType].fromObject({
				url: mediaUrl,
				directPath,
				fileSha256,
				fileLength,
				...uploadData,
				media: undefined
			})
		})

		if (uploadData.ptv) {
			obj.ptvMessage = obj.videoMessage
			delete obj.videoMessage
		}

		if (obj.stickerMessage) {
			obj.stickerMessage.stickerSentTs = Date.now()
		}

		if (cacheableKey) {
			logger?.debug({ cacheableKey }, 'set cache')
			await options.mediaCache!.set(cacheableKey, WAProto.Message.encode(obj).finish())
		}

		return obj
	}

	const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
	const requiresThumbnailComputation =
		(mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined'
	const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true
	const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true
	const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation
	const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(
		uploadData.media,
		options.mediaTypeOverride || mediaType,
		{
			logger,
			saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
			opts: options.options
		}
	)

	const fileEncSha256B64 = fileEncSha256.toString('base64')
	const [{ mediaUrl, directPath }] = await Promise.all([
		(async () => {
			const result = await options.upload(encFilePath, {
				fileEncSha256B64,
				mediaType,
				timeoutMs: options.mediaUploadTimeoutMs
			})
			logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
			return result
		})(),
		(async () => {
			try {
				if (requiresThumbnailComputation) {
					const { thumbnail, originalImageDimensions } = await generateThumbnail(
						originalFilePath!,
						mediaType as 'image' | 'video',
						options
					)
					uploadData.jpegThumbnail = thumbnail
					if (!uploadData.width && originalImageDimensions) {
						uploadData.width = originalImageDimensions.width
						uploadData.height = originalImageDimensions.height
						logger?.debug('set dimensions')
					}

					logger?.debug('generated thumbnail')
				}

				if (requiresDurationComputation) {
					uploadData.seconds = await getAudioDuration(originalFilePath!)
					logger?.debug('computed audio duration')
				}

				if (requiresWaveformProcessing) {
					uploadData.waveform = await getAudioWaveform(originalFilePath!, logger)
					logger?.debug('processed waveform')
				}

				if (requiresAudioBackground) {
					uploadData.backgroundArgb = await assertColor(options.backgroundColor)
					logger?.debug('computed backgroundColor audio status')
				}
			} catch (error) {
				logger?.warn({ trace: (error as any).stack }, 'failed to obtain extra info')
			}
		})()
	]).finally(async () => {
		try {
			await fs.unlink(encFilePath)
			if (originalFilePath) {
				await fs.unlink(originalFilePath)
			}

			logger?.debug('removed tmp files')
		} catch (error) {
			logger?.warn('failed to remove tmp file')
		}
	})

	const obj = WAProto.Message.fromObject({
		[`${mediaType}Message`]: MessageTypeProto[mediaType as keyof typeof MessageTypeProto].fromObject({
			url: mediaUrl,
			directPath,
			mediaKey,
			fileEncSha256,
			fileSha256,
			fileLength,
			mediaKeyTimestamp: unixTimestampSeconds(),
			...uploadData,
			media: undefined
		} as any)
	})

	if (uploadData.ptv) {
		obj.ptvMessage = obj.videoMessage
		delete obj.videoMessage
	}

	if (cacheableKey) {
		logger?.debug({ cacheableKey }, 'set cache')
		await options.mediaCache!.set(cacheableKey, WAProto.Message.encode(obj).finish())
	}

	return obj
}

export const prepareDisappearingMessageSettingContent = (ephemeralExpiration?: number) => {
	ephemeralExpiration = ephemeralExpiration || 0
	const content: WAMessageContent = {
		ephemeralMessage: {
			message: {
				protocolMessage: {
					type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
					ephemeralExpiration
				}
			}
		}
	}
	return WAProto.Message.fromObject(content)
}

/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export const generateForwardMessageContent = (message: WAMessage, forceForward?: boolean) => {
	let content = message.message
	if (!content) {
		throw new Boom('no content in message', { statusCode: 400 })
	}

	// hacky copy
	content = normalizeMessageContent(content)
	content = proto.Message.decode(proto.Message.encode(content!).finish())

	let key = Object.keys(content)[0] as keyof proto.IMessage

	let score = (content?.[key] as { contextInfo: proto.IContextInfo })?.contextInfo?.forwardingScore || 0
	score += message.key.fromMe && !forceForward ? 0 : 1
	if (key === 'conversation') {
		content.extendedTextMessage = { text: content[key] }
		delete content.conversation

		key = 'extendedTextMessage'
	}

	const key_ = content?.[key] as { contextInfo: proto.IContextInfo }
	if (score > 0) {
		key_.contextInfo = { forwardingScore: score, isForwarded: true }
	} else {
		key_.contextInfo = {}
	}

	return content
}

export const generateWAMessageContent = async (
	message: AnyMessageContent,
	options: MessageContentGenerationOptions
) => {
	let m: WAMessageContent = {}
	if ('text' in message) {
		const extContent = { text: message.text } as WATextMessage

		let urlInfo = message.linkPreview
		if (typeof urlInfo === 'undefined') {
			urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger)
		}

		if (urlInfo) {
			extContent.matchedText = urlInfo['matched-text']
			extContent.jpegThumbnail = urlInfo.jpegThumbnail
			extContent.description = urlInfo.description
			extContent.title = urlInfo.title
			extContent.previewType = 0

			const img = urlInfo.highQualityThumbnail
			if (img) {
				extContent.thumbnailDirectPath = img.directPath
				extContent.mediaKey = img.mediaKey
				extContent.mediaKeyTimestamp = img.mediaKeyTimestamp
				extContent.thumbnailWidth = img.width
				extContent.thumbnailHeight = img.height
				extContent.thumbnailSha256 = img.fileSha256
				extContent.thumbnailEncSha256 = img.fileEncSha256
			}
		}

		if (options.backgroundColor) {
			extContent.backgroundArgb = await assertColor(options.backgroundColor)
		}

		if (options.font) {
			extContent.font = options.font
		}

		m.extendedTextMessage = extContent
	} else if ('contacts' in message) {
		const contactLen = message.contacts.contacts.length
		if (!contactLen) {
			throw new Boom('require atleast 1 contact', { statusCode: 400 })
		}

		if (contactLen === 1) {
			m.contactMessage = WAProto.Message.ContactMessage.create(message.contacts.contacts[0])
		} else {
			m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(message.contacts)
		}
	} else if ('location' in message) {
		m.locationMessage = WAProto.Message.LocationMessage.create(message.location)
	} else if ('react' in message) {
		if (!message.react.senderTimestampMs) {
			message.react.senderTimestampMs = Date.now()
		}

		m.reactionMessage = WAProto.Message.ReactionMessage.create(message.react)
	} else if ('delete' in message) {
		m.protocolMessage = {
			key: message.delete,
			type: WAProto.Message.ProtocolMessage.Type.REVOKE
		}
	} else if ('forward' in message) {
		m = generateForwardMessageContent(message.forward, message.force)
	} else if ('disappearingMessagesInChat' in message) {
		const exp =
			typeof message.disappearingMessagesInChat === 'boolean'
				? message.disappearingMessagesInChat
					? WA_DEFAULT_EPHEMERAL
					: 0
				: message.disappearingMessagesInChat
		m = prepareDisappearingMessageSettingContent(exp)
	} else if ('groupInvite' in message) {
		m.groupInviteMessage = {}
		m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode
		m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration
		m.groupInviteMessage.caption = message.groupInvite.text

		m.groupInviteMessage.groupJid = message.groupInvite.jid
		m.groupInviteMessage.groupName = message.groupInvite.subject
		//TODO: use built-in interface and get disappearing mode info etc.
		//TODO: cache / use store!?
		if (options.getProfilePicUrl) {
			const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview')
			if (pfpUrl) {
				const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher })
				if (resp.ok) {
					const buf = Buffer.from(await resp.arrayBuffer())
					m.groupInviteMessage.jpegThumbnail = buf
				}
			}
		}
	} else if ('pin' in message) {
		m.pinInChatMessage = {}
		m.messageContextInfo = {}

		m.pinInChatMessage.key = message.pin
		m.pinInChatMessage.type = message.type
		m.pinInChatMessage.senderTimestampMs = Date.now()

		m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0
	} else if ('buttonReply' in message) {
		switch (message.type) {
			case 'template':
				m.templateButtonReplyMessage = {
					selectedDisplayText: message.buttonReply.displayText,
					selectedId: message.buttonReply.id,
					selectedIndex: message.buttonReply.index
				}
				break
			case 'plain':
				m.buttonsResponseMessage = {
					selectedButtonId: message.buttonReply.id,
					selectedDisplayText: message.buttonReply.displayText,
					type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
				}
				break
		}
	} else if ('ptv' in message && message.ptv) {
		const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options)
		m.ptvMessage = videoMessage
	} else if ('product' in message) {
		const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options)
		m.productMessage = WAProto.Message.ProductMessage.create({
			...message,
			product: {
				...message.product,
				productImage: imageMessage
			}
		})
	} else if ('listReply' in message) {
		m.listResponseMessage = { ...message.listReply }
	} else if ('event' in message) {
		m.eventMessage = {}
		const startTime = Math.floor(message.event.startDate.getTime() / 1000)

		if (message.event.call && options.getCallLink) {
			const token = await options.getCallLink(message.event.call, { startTime })
			m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token
		}

		m.messageContextInfo = {
			// encKey
			messageSecret: message.event.messageSecret || randomBytes(32)
		}

		m.eventMessage.name = message.event.name
		m.eventMessage.description = message.event.description
		m.eventMessage.startTime = startTime
		m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined
		m.eventMessage.isCanceled = message.event.isCancelled ?? false
		m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed
		m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false
		m.eventMessage.location = message.event.location
	} else if ('poll' in message) {
		message.poll.selectableCount ||= 0
		message.poll.toAnnouncementGroup ||= false

		if (!Array.isArray(message.poll.values)) {
			throw new Boom('Invalid poll values', { statusCode: 400 })
		}

		if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
			throw new Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
				statusCode: 400
			})
		}

		m.messageContextInfo = {
			// encKey
			messageSecret: message.poll.messageSecret || randomBytes(32)
		}

		const pollCreationMessage = {
			name: message.poll.name,
			selectableOptionsCount: message.poll.selectableCount,
			options: message.poll.values.map(optionName => ({ optionName }))
		}

		if (message.poll.toAnnouncementGroup) {
			// poll v2 is for community announcement groups (single select and multiple)
			m.pollCreationMessageV2 = pollCreationMessage
		} else {
			if (message.poll.selectableCount === 1) {
				//poll v3 is for single select polls
				m.pollCreationMessageV3 = pollCreationMessage
			} else {
				// poll for multiple choice polls
				m.pollCreationMessage = pollCreationMessage
			}
		}
	} else if ('sharePhoneNumber' in message) {
		m.protocolMessage = {
			type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
		}
	} else if ('requestPhoneNumber' in message) {
		m.requestPhoneNumberMessage = {}
	} else if ('limitSharing' in message) {
		m.protocolMessage = {
			type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
			limitSharing: {
				sharingLimited: message.limitSharing === true,
				trigger: 1,
				limitSharingSettingTimestamp: Date.now(),
				initiatedByMe: true
			}
		}
	} else {
		m = await prepareWAMessageMedia(message, options)
	}

	if ('viewOnce' in message && !!message.viewOnce) {
		m = { viewOnceMessage: { message: m } }
	}

	if ('mentions' in message && message.mentions?.length) {
		const messageType = Object.keys(m)[0]! as Extract<keyof proto.IMessage, MessageWithContextInfo>
		const key = m[messageType]
		if ('contextInfo' in key! && !!key.contextInfo) {
			key.contextInfo.mentionedJid = message.mentions
		} else if (key!) {
			key.contextInfo = {
				mentionedJid: message.mentions
			}
		}
	}

	if ('edit' in message) {
		m = {
			protocolMessage: {
				key: message.edit,
				editedMessage: m,
				timestampMs: Date.now(),
				type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
			}
		}
	}

	if ('contextInfo' in message && !!message.contextInfo) {
		const messageType = Object.keys(m)[0]! as Extract<keyof proto.IMessage, MessageWithContextInfo>
		const key = m[messageType]
		if ('contextInfo' in key! && !!key.contextInfo) {
			key.contextInfo = { ...key.contextInfo, ...message.contextInfo }
		} else if (key!) {
			key.contextInfo = message.contextInfo
		}
	}

	return WAProto.Message.create(m)
}

export const generateWAMessageFromContent = (
	jid: string,
	message: WAMessageContent,
	options: MessageGenerationOptionsFromContent
) => {
	// set timestamp to now
	// if not specified
	if (!options.timestamp) {
		options.timestamp = new Date()
	}

	const innerMessage = normalizeMessageContent(message)!
	const key = getContentType(innerMessage)! as Exclude<keyof proto.IMessage, 'conversation'>
	const timestamp = unixTimestampSeconds(options.timestamp)
	const { quoted, userJid } = options

	if (quoted && !isJidNewsletter(jid)) {
		const participant = quoted.key.fromMe
			? userJid // TODO: Add support for LIDs
			: quoted.participant || quoted.key.participant || quoted.key.remoteJid

		let quotedMsg = normalizeMessageContent(quoted.message)!
		const msgType = getContentType(quotedMsg)!
		// strip any redundant properties
		quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] })

		const quotedContent = quotedMsg[msgType]
		if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
			delete quotedContent.contextInfo
		}

		const contextInfo: proto.IContextInfo =
			('contextInfo' in innerMessage[key]! && innerMessage[key]?.contextInfo) || {}
		contextInfo.participant = jidNormalizedUser(participant!)
		contextInfo.stanzaId = quoted.key.id
		contextInfo.quotedMessage = quotedMsg

		// if a participant is quoted, then it must be a group
		// hence, remoteJid of group must also be entered
		if (jid !== quoted.key.remoteJid) {
			contextInfo.remoteJid = quoted.key.remoteJid
		}

		if (contextInfo && innerMessage[key]) {
			/* @ts-ignore */
			innerMessage[key].contextInfo = contextInfo
		}
	}

	if (
		// if we want to send a disappearing message
		!!options?.ephemeralExpiration &&
		// and it's not a protocol message -- delete, toggle disappear message
		key !== 'protocolMessage' &&
		// already not converted to disappearing message
		key !== 'ephemeralMessage' &&
		// newsletters don't support ephemeral messages
		!isJidNewsletter(jid)
	) {
		/* @ts-ignore */
		innerMessage[key].contextInfo = {
			...((innerMessage[key] as any).contextInfo || {}),
			expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL
			//ephemeralSettingTimestamp: options.ephemeralOptions.eph_setting_ts?.toString()
		}
	}

	message = WAProto.Message.create(message)

	const messageJSON = {
		key: {
			remoteJid: jid,
			fromMe: true,
			id: options?.messageId || generateMessageIDV2()
		},
		message: message,
		messageTimestamp: timestamp,
		messageStubParameters: [],
		participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined, // TODO: Add support for LIDs
		status: WAMessageStatus.PENDING
	}
	return WAProto.WebMessageInfo.fromObject(messageJSON) as WAMessage
}

export const generateWAMessage = async (jid: string, content: AnyMessageContent, options: MessageGenerationOptions) => {
	// ensure msg ID is with every log
	options.logger = options?.logger?.child({ msgId: options.messageId })
	// Pass jid in the options to generateWAMessageContent
	return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid }), options)
}

/** Get the key to access the true type of content */
export const getContentType = (content: proto.IMessage | undefined) => {
	if (content) {
		const keys = Object.keys(content)
		const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage')
		return key as keyof typeof content
	}
}

/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export const normalizeMessageContent = (content: WAMessageContent | null | undefined): WAMessageContent | undefined => {
	if (!content) {
		return undefined
	}

	// set max iterations to prevent an infinite loop
	for (let i = 0; i < 5; i++) {
		const inner = getFutureProofMessage(content)
		if (!inner) {
			break
		}

		content = inner.message
	}

	return content!

	function getFutureProofMessage(message: typeof content) {
		return (
			message?.ephemeralMessage ||
			message?.viewOnceMessage ||
			message?.documentWithCaptionMessage ||
			message?.viewOnceMessageV2 ||
			message?.viewOnceMessageV2Extension ||
			message?.editedMessage
		)
	}
}

/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export const extractMessageContent = (content: WAMessageContent | undefined | null): WAMessageContent | undefined => {
	const extractFromTemplateMessage = (
		msg: proto.Message.TemplateMessage.IHydratedFourRowTemplate | proto.Message.IButtonsMessage
	) => {
		if (msg.imageMessage) {
			return { imageMessage: msg.imageMessage }
		} else if (msg.documentMessage) {
			return { documentMessage: msg.documentMessage }
		} else if (msg.videoMessage) {
			return { videoMessage: msg.videoMessage }
		} else if (msg.locationMessage) {
			return { locationMessage: msg.locationMessage }
		} else {
			return {
				conversation:
					'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : ''
			}
		}
	}

	content = normalizeMessageContent(content)

	if (content?.buttonsMessage) {
		return extractFromTemplateMessage(content.buttonsMessage)
	}

	if (content?.templateMessage?.hydratedFourRowTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate)
	}

	if (content?.templateMessage?.hydratedTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate)
	}

	if (content?.templateMessage?.fourRowTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate)
	}

	return content
}

/**
 * Returns the device predicted by message ID
 */
export const getDevice = (id: string) =>
	/^3A.{18}$/.test(id)
		? 'ios'
		: /^3E.{20}$/.test(id)
			? 'web'
			: /^(.{21}|.{32})$/.test(id)
				? 'android'
				: /^(3F|.{18}$)/.test(id)
					? 'desktop'
					: 'unknown'

/** Upserts a receipt in the message */
export const updateMessageWithReceipt = (msg: Pick<WAMessage, 'userReceipt'>, receipt: MessageUserReceipt) => {
	msg.userReceipt = msg.userReceipt || []
	const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
	if (recp) {
		Object.assign(recp, receipt)
	} else {
		msg.userReceipt.push(receipt)
	}
}

/** Update the message with a new reaction */
export const updateMessageWithReaction = (msg: Pick<WAMessage, 'reactions'>, reaction: proto.IReaction) => {
	const authorID = getKeyAuthor(reaction.key)

	const reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID)
	reaction.text = reaction.text || ''
	reactions.push(reaction)
	msg.reactions = reactions
}

/** Update the message with a new poll update */
export const updateMessageWithPollUpdate = (msg: Pick<WAMessage, 'pollUpdates'>, update: proto.IPollUpdate) => {
	const authorID = getKeyAuthor(update.pollUpdateMessageKey)

	const reactions = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID)
	if (update.vote?.selectedOptions?.length) {
		reactions.push(update)
	}

	msg.pollUpdates = reactions
}

type VoteAggregation = {
	name: string
	voters: string[]
}

/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
export function getAggregateVotesInPollMessage(
	{ message, pollUpdates }: Pick<WAMessage, 'pollUpdates' | 'message'>,
	meId?: string
) {
	const opts =
		message?.pollCreationMessage?.options ||
		message?.pollCreationMessageV2?.options ||
		message?.pollCreationMessageV3?.options ||
		[]
	const voteHashMap = opts.reduce(
		(acc, opt) => {
			const hash = sha256(Buffer.from(opt.optionName || '')).toString()
			acc[hash] = {
				name: opt.optionName || '',
				voters: []
			}
			return acc
		},
		{} as { [_: string]: VoteAggregation }
	)

	for (const update of pollUpdates || []) {
		const { vote } = update
		if (!vote) {
			continue
		}

		for (const option of vote.selectedOptions || []) {
			const hash = option.toString()
			let data = voteHashMap[hash]
			if (!data) {
				voteHashMap[hash] = {
					name: 'Unknown',
					voters: []
				}
				data = voteHashMap[hash]
			}

			voteHashMap[hash]!.voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId))
		}
	}

	return Object.values(voteHashMap)
}

/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
export const aggregateMessageKeysNotFromMe = (keys: WAMessageKey[]) => {
	const keyMap: { [id: string]: { jid: string; participant: string | undefined; messageIds: string[] } } = {}
	for (const { remoteJid, id, participant, fromMe } of keys) {
		if (!fromMe) {
			const uqKey = `${remoteJid}:${participant || ''}`
			if (!keyMap[uqKey]) {
				keyMap[uqKey] = {
					jid: remoteJid!,
					participant: participant!,
					messageIds: []
				}
			}

			keyMap[uqKey].messageIds.push(id!)
		}
	}

	return Object.values(keyMap)
}

type DownloadMediaMessageContext = {
	reuploadRequest: (msg: WAMessage) => Promise<WAMessage>
	logger: ILogger
}

const REUPLOAD_REQUIRED_STATUS = [410, 404]

/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export const downloadMediaMessage = async <Type extends 'buffer' | 'stream'>(
	message: WAMessage,
	type: Type,
	options: MediaDownloadOptions,
	ctx?: DownloadMediaMessageContext
) => {
	const result = await downloadMsg().catch(async error => {
		if (
			ctx &&
			typeof error?.status === 'number' && // treat errors with status as HTTP failures requiring reupload
			REUPLOAD_REQUIRED_STATUS.includes(error.status as number)
		) {
			ctx.logger.info({ key: message.key }, 'sending reupload media request...')
			// request reupload
			message = await ctx.reuploadRequest(message)
			const result = await downloadMsg()
			return result
		}

		throw error
	})

	return result as Type extends 'buffer' ? Buffer : Transform

	async function downloadMsg() {
		const mContent = extractMessageContent(message.message)
		if (!mContent) {
			throw new Boom('No message present', { statusCode: 400, data: message })
		}

		const contentType = getContentType(mContent)
		let mediaType = contentType?.replace('Message', '') as MediaType
		const media = mContent[contentType!]

		if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
			throw new Boom(`"${contentType}" message is not a media message`)
		}

		let download: DownloadableMessage
		if ('thumbnailDirectPath' in media && !('url' in media)) {
			download = {
				directPath: media.thumbnailDirectPath,
				mediaKey: media.mediaKey
			}
			mediaType = 'thumbnail-link'
		} else {
			download = media
		}

		const stream = await downloadContentFromMessage(download, mediaType, options)
		if (type === 'buffer') {
			const bufferArray: Buffer[] = []
			for await (const chunk of stream) {
				bufferArray.push(chunk)
			}

			return Buffer.concat(bufferArray)
		}

		return stream
	}
}

/** Checks whether the given message is a media message; if it is returns the inner content */
export const assertMediaContent = (content: proto.IMessage | null | undefined) => {
	content = extractMessageContent(content)
	const mediaContent =
		content?.documentMessage ||
		content?.imageMessage ||
		content?.videoMessage ||
		content?.audioMessage ||
		content?.stickerMessage
	if (!mediaContent) {
		throw new Boom('given message is not a media message', { statusCode: 400, data: content })
	}

	return mediaContent
}



================================================
FILE: src/Utils/noise-handler.ts
================================================
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { NOISE_MODE, WA_CERT_DETAILS } from '../Defaults'
import type { KeyPair } from '../Types'
import type { BinaryNode } from '../WABinary'
import { decodeBinaryNode } from '../WABinary'
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from './crypto'
import type { ILogger } from './logger'

const generateIV = (counter: number) => {
	const iv = new ArrayBuffer(12)
	new DataView(iv).setUint32(8, counter)

	return new Uint8Array(iv)
}

export const makeNoiseHandler = ({
	keyPair: { private: privateKey, public: publicKey },
	NOISE_HEADER,
	logger,
	routingInfo
}: {
	keyPair: KeyPair
	NOISE_HEADER: Uint8Array
	logger: ILogger
	routingInfo?: Buffer | undefined
}) => {
	logger = logger.child({ class: 'ns' })

	const authenticate = (data: Uint8Array) => {
		if (!isFinished) {
			hash = sha256(Buffer.concat([hash, data]))
		}
	}

	const encrypt = (plaintext: Uint8Array) => {
		const result = aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash)

		writeCounter += 1

		authenticate(result)
		return result
	}

	const decrypt = (ciphertext: Uint8Array) => {
		// before the handshake is finished, we use the same counter
		// after handshake, the counters are different
		const iv = generateIV(isFinished ? readCounter : writeCounter)
		const result = aesDecryptGCM(ciphertext, decKey, iv, hash)

		if (isFinished) {
			readCounter += 1
		} else {
			writeCounter += 1
		}

		authenticate(ciphertext)
		return result
	}

	const localHKDF = async (data: Uint8Array) => {
		const key = await hkdf(Buffer.from(data), 64, { salt, info: '' })
		return [key.slice(0, 32), key.slice(32)]
	}

	const mixIntoKey = async (data: Uint8Array) => {
		const [write, read] = await localHKDF(data)
		salt = write!
		encKey = read!
		decKey = read!
		readCounter = 0
		writeCounter = 0
	}

	const finishInit = async () => {
		const [write, read] = await localHKDF(new Uint8Array(0))
		encKey = write!
		decKey = read!
		hash = Buffer.from([])
		readCounter = 0
		writeCounter = 0
		isFinished = true
	}

	const data = Buffer.from(NOISE_MODE)
	let hash = data.byteLength === 32 ? data : sha256(data)
	let salt = hash
	let encKey = hash
	let decKey = hash
	let readCounter = 0
	let writeCounter = 0
	let isFinished = false
	let sentIntro = false

	let inBytes = Buffer.alloc(0)

	authenticate(NOISE_HEADER)
	authenticate(publicKey)

	return {
		encrypt,
		decrypt,
		authenticate,
		mixIntoKey,
		finishInit,
		processHandshake: async ({ serverHello }: proto.HandshakeMessage, noiseKey: KeyPair) => {
			authenticate(serverHello!.ephemeral!)
			await mixIntoKey(Curve.sharedKey(privateKey, serverHello!.ephemeral!))

			const decStaticContent = decrypt(serverHello!.static!)
			await mixIntoKey(Curve.sharedKey(privateKey, decStaticContent))

			const certDecoded = decrypt(serverHello!.payload!)

			const { intermediate: certIntermediate } = proto.CertChain.decode(certDecoded)

			const { issuerSerial } = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate!.details!)

			if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
				throw new Boom('certification match failed', { statusCode: 400 })
			}

			const keyEnc = encrypt(noiseKey.public)
			await mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello!.ephemeral!))

			return keyEnc
		},
		encodeFrame: (data: Buffer | Uint8Array) => {
			if (isFinished) {
				data = encrypt(data)
			}

			let header: Buffer

			if (routingInfo) {
				header = Buffer.alloc(7)
				header.write('ED', 0, 'utf8')
				header.writeUint8(0, 2)
				header.writeUint8(1, 3)
				header.writeUint8(routingInfo.byteLength >> 16, 4)
				header.writeUint16BE(routingInfo.byteLength & 65535, 5)
				header = Buffer.concat([header, routingInfo, NOISE_HEADER])
			} else {
				header = Buffer.from(NOISE_HEADER)
			}

			const introSize = sentIntro ? 0 : header.length
			const frame = Buffer.alloc(introSize + 3 + data.byteLength)

			if (!sentIntro) {
				frame.set(header)
				sentIntro = true
			}

			frame.writeUInt8(data.byteLength >> 16, introSize)
			frame.writeUInt16BE(65535 & data.byteLength, introSize + 1)
			frame.set(data, introSize + 3)

			return frame
		},
		decodeFrame: async (newData: Buffer | Uint8Array, onFrame: (buff: Uint8Array | BinaryNode) => void) => {
			// the binary protocol uses its own framing mechanism
			// on top of the WS frames
			// so we get this data and separate out the frames
			const getBytesSize = () => {
				if (inBytes.length >= 3) {
					return (inBytes.readUInt8() << 16) | inBytes.readUInt16BE(1)
				}
			}

			inBytes = Buffer.concat([inBytes, newData])

			logger.trace(`recv ${newData.length} bytes, total recv ${inBytes.length} bytes`)

			let size = getBytesSize()
			while (size && inBytes.length >= size + 3) {
				let frame: Uint8Array | BinaryNode = inBytes.slice(3, size + 3)
				inBytes = inBytes.slice(size + 3)

				if (isFinished) {
					const result = decrypt(frame)
					frame = await decodeBinaryNode(result)
				}

				logger.trace({ msg: (frame as BinaryNode)?.attrs?.id }, 'recv frame')

				onFrame(frame)
				size = getBytesSize()
			}
		}
	}
}



================================================
FILE: src/Utils/pre-key-manager.ts
================================================
import PQueue from 'p-queue'
import type { SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../Types'
import type { ILogger } from './logger'

/**
 * Manages pre-key operations with proper concurrency control
 */
export class PreKeyManager {
	private readonly queues = new Map<string, PQueue>()

	constructor(
		private readonly store: SignalKeyStore,
		private readonly logger: ILogger
	) {}

	/**
	 * Get or create a queue for a specific key type
	 */
	private getQueue(keyType: string): PQueue {
		if (!this.queues.has(keyType)) {
			this.queues.set(keyType, new PQueue({ concurrency: 1 }))
		}

		return this.queues.get(keyType)!
	}

	/**
	 * Process pre-key operations (updates and deletions)
	 */
	async processOperations(
		data: SignalDataSet,
		keyType: keyof SignalDataTypeMap,
		transactionCache: SignalDataSet,
		mutations: SignalDataSet,
		isInTransaction: boolean
	): Promise<void> {
		const keyData = data[keyType]
		if (!keyData) return

		return this.getQueue(keyType).add(async () => {
			// Ensure structures exist
			transactionCache[keyType] = transactionCache[keyType] || ({} as any)
			mutations[keyType] = mutations[keyType] || ({} as any)

			// Separate deletions from updates
			const deletions: string[] = []
			const updates: Record<string, any> = {}

			for (const keyId in keyData) {
				if (keyData[keyId] === null) {
					deletions.push(keyId)
				} else {
					updates[keyId] = keyData[keyId]
				}
			}

			// Process updates (no validation needed)
			if (Object.keys(updates).length > 0) {
				Object.assign(transactionCache[keyType]!, updates)
				Object.assign(mutations[keyType]!, updates)
			}

			// Process deletions with validation
			if (deletions.length > 0) {
				await this.processDeletions(keyType, deletions, transactionCache, mutations, isInTransaction)
			}
		})
	}

	/**
	 * Process deletions with validation
	 */
	private async processDeletions(
		keyType: keyof SignalDataTypeMap,
		ids: string[],
		transactionCache: SignalDataSet,
		mutations: SignalDataSet,
		isInTransaction: boolean
	): Promise<void> {
		if (isInTransaction) {
			// In transaction, only allow deletion if key exists in cache
			for (const keyId of ids) {
				if (transactionCache[keyType]?.[keyId]) {
					transactionCache[keyType][keyId] = null
					mutations[keyType]![keyId] = null
				} else {
					this.logger.warn(`Skipping deletion of non-existent ${keyType} in transaction: ${keyId}`)
				}
			}
		} else {
			// Outside transaction, validate against store
			const existingKeys = await this.store.get(keyType, ids)
			for (const keyId of ids) {
				if (existingKeys[keyId]) {
					transactionCache[keyType]![keyId] = null
					mutations[keyType]![keyId] = null
				} else {
					this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
				}
			}
		}
	}

	/**
	 * Validate and process pre-key deletions outside transactions
	 */
	async validateDeletions(data: SignalDataSet, keyType: keyof SignalDataTypeMap): Promise<void> {
		const keyData = data[keyType]
		if (!keyData) return

		return this.getQueue(keyType).add(async () => {
			// Find all deletion requests
			const deletionIds = Object.keys(keyData).filter(id => keyData[id] === null)
			if (deletionIds.length === 0) return

			// Validate deletions
			const existingKeys = await this.store.get(keyType, deletionIds)
			for (const keyId of deletionIds) {
				if (!existingKeys[keyId]) {
					this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
					delete data[keyType]![keyId]
				}
			}
		})
	}
}



================================================
FILE: src/Utils/process-message.ts
================================================
import { proto } from '../../WAProto/index.js'
import type {
	AuthenticationCreds,
	BaileysEventEmitter,
	CacheStore,
	Chat,
	GroupMetadata,
	GroupParticipant,
	LIDMapping,
	ParticipantAction,
	RequestJoinAction,
	RequestJoinMethod,
	SignalKeyStoreWithTransaction,
	SignalRepositoryWithLIDStore,
	WAMessage,
	WAMessageKey
} from '../Types'
import { WAMessageStubType } from '../Types'
import { getContentType, normalizeMessageContent } from '../Utils/messages'
import {
	areJidsSameUser,
	isHostedLidUser,
	isHostedPnUser,
	isJidBroadcast,
	isJidStatusBroadcast,
	jidDecode,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { aesDecryptGCM, hmacSign } from './crypto'
import { toNumber } from './generics'
import { downloadAndProcessHistorySyncNotification } from './history'
import type { ILogger } from './logger'

type ProcessMessageContext = {
	shouldProcessHistoryMsg: boolean
	placeholderResendCache?: CacheStore
	creds: AuthenticationCreds
	keyStore: SignalKeyStoreWithTransaction
	ev: BaileysEventEmitter
	logger?: ILogger
	options: RequestInit
	signalRepository: SignalRepositoryWithLIDStore
}

const REAL_MSG_STUB_TYPES = new Set([
	WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
	WAMessageStubType.CALL_MISSED_GROUP_VOICE,
	WAMessageStubType.CALL_MISSED_VIDEO,
	WAMessageStubType.CALL_MISSED_VOICE
])

const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD])

/** Cleans a received message to further processing */
export const cleanMessage = (message: WAMessage, meId: string, meLid: string) => {
	// ensure remoteJid and participant doesn't have device or agent in it
	if (isHostedPnUser(message.key.remoteJid!) || isHostedLidUser(message.key.remoteJid!)) {
		message.key.remoteJid = jidEncode(
			jidDecode(message.key?.remoteJid!)?.user!,
			isHostedPnUser(message.key.remoteJid!) ? 's.whatsapp.net' : 'lid'
		)
	} else {
		message.key.remoteJid = jidNormalizedUser(message.key.remoteJid!)
	}

	if (isHostedPnUser(message.key.participant!) || isHostedLidUser(message.key.participant!)) {
		message.key.participant = jidEncode(
			jidDecode(message.key.participant!)?.user!,
			isHostedPnUser(message.key.participant!) ? 's.whatsapp.net' : 'lid'
		)
	} else {
		message.key.participant = jidNormalizedUser(message.key.participant!)
	}

	const content = normalizeMessageContent(message.message)
	// if the message has a reaction, ensure fromMe & remoteJid are from our perspective
	if (content?.reactionMessage) {
		normaliseKey(content.reactionMessage.key!)
	}

	if (content?.pollUpdateMessage) {
		normaliseKey(content.pollUpdateMessage.pollCreationMessageKey!)
	}

	function normaliseKey(msgKey: WAMessageKey) {
		// if the reaction is from another user
		// we've to correctly map the key to this user's perspective
		if (!message.key.fromMe) {
			// if the sender believed the message being reacted to is not from them
			// we've to correct the key to be from them, or some other participant
			msgKey.fromMe = !msgKey.fromMe
				? areJidsSameUser(msgKey.participant || msgKey.remoteJid!, meId) ||
					areJidsSameUser(msgKey.participant || msgKey.remoteJid!, meLid)
				: // if the message being reacted to, was from them
					// fromMe automatically becomes false
					false
			// set the remoteJid to being the same as the chat the message came from
			// TODO: investigate inconsistencies
			msgKey.remoteJid = message.key.remoteJid
			// set participant of the message
			msgKey.participant = msgKey.participant || message.key.participant
		}
	}
}

// TODO: target:audit AUDIT THIS FUNCTION AGAIN
export const isRealMessage = (message: WAMessage) => {
	const normalizedContent = normalizeMessageContent(message.message)
	const hasSomeContent = !!getContentType(normalizedContent)
	return (
		(!!normalizedContent ||
			REAL_MSG_STUB_TYPES.has(message.messageStubType!) ||
			REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType!)) &&
		hasSomeContent &&
		!normalizedContent?.protocolMessage &&
		!normalizedContent?.reactionMessage &&
		!normalizedContent?.pollUpdateMessage
	)
}

export const shouldIncrementChatUnread = (message: WAMessage) => !message.key.fromMe && !message.messageStubType

/**
 * Get the ID of the chat from the given key.
 * Typically -- that'll be the remoteJid, but for broadcasts, it'll be the participant
 */
export const getChatId = ({ remoteJid, participant, fromMe }: WAMessageKey) => {
	if (isJidBroadcast(remoteJid!) && !isJidStatusBroadcast(remoteJid!) && !fromMe) {
		return participant!
	}

	return remoteJid!
}

type PollContext = {
	/** normalised jid of the person that created the poll */
	pollCreatorJid: string
	/** ID of the poll creation message */
	pollMsgId: string
	/** poll creation message enc key */
	pollEncKey: Uint8Array
	/** jid of the person that voted */
	voterJid: string
}

/**
 * Decrypt a poll vote
 * @param vote encrypted vote
 * @param ctx additional info about the poll required for decryption
 * @returns list of SHA256 options
 */
export function decryptPollVote(
	{ encPayload, encIv }: proto.Message.IPollEncValue,
	{ pollCreatorJid, pollMsgId, pollEncKey, voterJid }: PollContext
) {
	const sign = Buffer.concat([
		toBinary(pollMsgId),
		toBinary(pollCreatorJid),
		toBinary(voterJid),
		toBinary('Poll Vote'),
		new Uint8Array([1])
	])

	const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256')
	const decKey = hmacSign(sign, key0, 'sha256')
	const aad = toBinary(`${pollMsgId}\u0000${voterJid}`)

	const decrypted = aesDecryptGCM(encPayload!, decKey, encIv!, aad)
	return proto.Message.PollVoteMessage.decode(decrypted)

	function toBinary(txt: string) {
		return Buffer.from(txt)
	}
}

const processMessage = async (
	message: WAMessage,
	{
		shouldProcessHistoryMsg,
		placeholderResendCache,
		ev,
		creds,
		signalRepository,
		keyStore,
		logger,
		options
	}: ProcessMessageContext
) => {
	const meId = creds.me!.id
	const { accountSettings } = creds

	const chat: Partial<Chat> = { id: jidNormalizedUser(getChatId(message.key)) }
	const isRealMsg = isRealMessage(message)

	if (isRealMsg) {
		chat.messages = [{ message }]
		chat.conversationTimestamp = toNumber(message.messageTimestamp)
		// only increment unread count if not CIPHERTEXT and from another person
		if (shouldIncrementChatUnread(message)) {
			chat.unreadCount = (chat.unreadCount || 0) + 1
		}
	}

	const content = normalizeMessageContent(message.message)

	// unarchive chat if it's a real message, or someone reacted to our message
	// and we've the unarchive chats setting on
	if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
		chat.archived = false
		chat.readOnly = false
	}

	const protocolMsg = content?.protocolMessage
	if (protocolMsg) {
		switch (protocolMsg.type) {
			case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
				const histNotification = protocolMsg.historySyncNotification!
				const process = shouldProcessHistoryMsg
				const isLatest = !creds.processedHistoryMessages?.length

				logger?.info(
					{
						histNotification,
						process,
						id: message.key.id,
						isLatest
					},
					'got history notification'
				)

				if (process) {
					// TODO: investigate
					if (histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
						ev.emit('creds.update', {
							processedHistoryMessages: [
								...(creds.processedHistoryMessages || []),
								{ key: message.key, messageTimestamp: message.messageTimestamp }
							]
						})
					}

					const data = await downloadAndProcessHistorySyncNotification(histNotification, options)

					ev.emit('messaging-history.set', {
						...data,
						isLatest: histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ? isLatest : undefined,
						peerDataRequestSessionId: histNotification.peerDataRequestSessionId
					})
				}

				break
			case proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE:
				const keys = protocolMsg.appStateSyncKeyShare!.keys
				if (keys?.length) {
					let newAppStateSyncKeyId = ''
					await keyStore.transaction(async () => {
						const newKeys: string[] = []
						for (const { keyData, keyId } of keys) {
							const strKeyId = Buffer.from(keyId!.keyId!).toString('base64')
							newKeys.push(strKeyId)

							await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData! } })

							newAppStateSyncKeyId = strKeyId
						}

						logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys')
					}, meId)

					ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId })
				} else {
					logger?.info({ protocolMsg }, 'recv app state sync with 0 keys')
				}

				break
			case proto.Message.ProtocolMessage.Type.REVOKE:
				ev.emit('messages.update', [
					{
						key: {
							...message.key,
							id: protocolMsg.key!.id
						},
						update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: message.key }
					}
				])
				break
			case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
				Object.assign(chat, {
					ephemeralSettingTimestamp: toNumber(message.messageTimestamp),
					ephemeralExpiration: protocolMsg.ephemeralExpiration || null
				})
				break
			case proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE:
				const response = protocolMsg.peerDataOperationRequestResponseMessage!
				if (response) {
					await placeholderResendCache?.del(response.stanzaId!)
					// TODO: IMPLEMENT HISTORY SYNC ETC (sticker uploads etc.).
					const { peerDataOperationResult } = response
					for (const result of peerDataOperationResult!) {
						const { placeholderMessageResendResponse: retryResponse } = result
						//eslint-disable-next-line max-depth
						if (retryResponse) {
							const webMessageInfo = proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes!)
							// wait till another upsert event is available, don't want it to be part of the PDO response message
							// TODO: parse through proper message handling utilities (to add relevant key fields)
							setTimeout(() => {
								ev.emit('messages.upsert', {
									messages: [webMessageInfo as WAMessage],
									type: 'notify',
									requestId: response.stanzaId!
								})
							}, 500)
						}
					}
				}

				break
			case proto.Message.ProtocolMessage.Type.MESSAGE_EDIT:
				ev.emit('messages.update', [
					{
						// flip the sender / fromMe properties because they're in the perspective of the sender
						key: { ...message.key, id: protocolMsg.key?.id },
						update: {
							message: {
								editedMessage: {
									message: protocolMsg.editedMessage
								}
							},
							messageTimestamp: protocolMsg.timestampMs
								? Math.floor(toNumber(protocolMsg.timestampMs) / 1000)
								: message.messageTimestamp
						}
					}
				])
				break
			case proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC:
				const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload!
				const { pnToLidMappings, chatDbMigrationTimestamp } =
					proto.LIDMigrationMappingSyncPayload.decode(encodedPayload)
				logger?.debug({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp')
				const pairs = []
				for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
					const lid = latestLid || assignedLid
					pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` })
				}

				await signalRepository.lidMapping.storeLIDPNMappings(pairs)
				if (pairs.length) {
					for (const { pn, lid } of pairs) {
						await signalRepository.migrateSession(pn, lid)
					}
				}
		}
	} else if (content?.reactionMessage) {
		const reaction: proto.IReaction = {
			...content.reactionMessage,
			key: message.key
		}
		ev.emit('messages.reaction', [
			{
				reaction,
				key: content.reactionMessage?.key!
			}
		])
	} else if (message.messageStubType) {
		const jid = message.key?.remoteJid!
		//let actor = whatsappID (message.participant)
		let participants: GroupParticipant[]
		const emitParticipantsUpdate = (action: ParticipantAction) =>
			ev.emit('group-participants.update', {
				id: jid,
				author: message.key.participant!,
				authorPn: message.key.participantAlt!,
				participants,
				action
			})
		const emitGroupUpdate = (update: Partial<GroupMetadata>) => {
			ev.emit('groups.update', [
				{ id: jid, ...update, author: message.key.participant ?? undefined, authorPn: message.key.participantAlt }
			])
		}

		const emitGroupRequestJoin = (participant: LIDMapping, action: RequestJoinAction, method: RequestJoinMethod) => {
			ev.emit('group.join-request', {
				id: jid,
				author: message.key.participant!,
				authorPn: message.key.participantAlt!,
				participant: participant.lid,
				participantPn: participant.pn,
				action,
				method: method!
			})
		}

		const participantsIncludesMe = () => participants.find(jid => areJidsSameUser(meId, jid.phoneNumber)) // ADD SUPPORT FOR LID

		switch (message.messageStubType) {
			case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('modify')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
			case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('remove')
				// mark the chat read only if you left the group
				if (participantsIncludesMe()) {
					chat.readOnly = true
				}

				break
			case WAMessageStubType.GROUP_PARTICIPANT_ADD:
			case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
			case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				if (participantsIncludesMe()) {
					chat.readOnly = false
				}

				emitParticipantsUpdate('add')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('demote')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
				participants = message.messageStubParameters.map((a: any) => JSON.parse(a as string)) || []
				emitParticipantsUpdate('promote')
				break
			case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
				const announceValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' })
				break
			case WAMessageStubType.GROUP_CHANGE_RESTRICT:
				const restrictValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' })
				break
			case WAMessageStubType.GROUP_CHANGE_SUBJECT:
				const name = message.messageStubParameters?.[0]
				chat.name = name
				emitGroupUpdate({ subject: name })
				break
			case WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
				const description = message.messageStubParameters?.[0]
				chat.description = description
				emitGroupUpdate({ desc: description })
				break
			case WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
				const code = message.messageStubParameters?.[0]
				emitGroupUpdate({ inviteCode: code })
				break
			case WAMessageStubType.GROUP_MEMBER_ADD_MODE:
				const memberAddValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' })
				break
			case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE:
				const approvalMode = message.messageStubParameters?.[0]
				emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' })
				break
			case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD: // TODO: Add other events
				const participant = JSON.parse(message.messageStubParameters?.[0]) as LIDMapping
				const action = message.messageStubParameters?.[1] as RequestJoinAction
				const method = message.messageStubParameters?.[2] as RequestJoinMethod
				emitGroupRequestJoin(participant, action, method)
				break
		}
	} /*  else if(content?.pollUpdateMessage) {
		const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey!
		// we need to fetch the poll creation message to get the poll enc key
		// TODO: make standalone, remove getMessage reference
		// TODO: Remove entirely
		const pollMsg = await getMessage(creationMsgKey)
		if(pollMsg) {
			const meIdNormalised = jidNormalizedUser(meId)
			const pollCreatorJid = getKeyAuthor(creationMsgKey, meIdNormalised)
			const voterJid = getKeyAuthor(message.key, meIdNormalised)
			const pollEncKey = pollMsg.messageContextInfo?.messageSecret!

			try {
				const voteMsg = decryptPollVote(
					content.pollUpdateMessage.vote!,
					{
						pollEncKey,
						pollCreatorJid,
						pollMsgId: creationMsgKey.id!,
						voterJid,
					}
				)
				ev.emit('messages.update', [
					{
						key: creationMsgKey,
						update: {
							pollUpdates: [
								{
									pollUpdateMessageKey: message.key,
									vote: voteMsg,
									senderTimestampMs: (content.pollUpdateMessage.senderTimestampMs! as Long).toNumber(),
								}
							]
						}
					}
				])
			} catch(err) {
				logger?.warn(
					{ err, creationMsgKey },
					'failed to decrypt poll vote'
				)
			}
		} else {
			logger?.warn(
				{ creationMsgKey },
				'poll creation message not found, cannot decrypt update'
			)
		}
		} */

	if (Object.keys(chat).length > 1) {
		ev.emit('chats.update', [chat])
	}
}

export default processMessage



================================================
FILE: src/Utils/signal.ts
================================================
import { KEY_BUNDLE_TYPE } from '../Defaults'
import type { SignalRepositoryWithLIDStore } from '../Types'
import type {
	AuthenticationCreds,
	AuthenticationState,
	KeyPair,
	SignalIdentity,
	SignalKeyStore,
	SignedKeyPair
} from '../Types/Auth'
import {
	assertNodeErrorFree,
	type BinaryNode,
	type FullJid,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildUInt,
	jidDecode,
	S_WHATSAPP_NET,
	WAJIDDomains
} from '../WABinary'
import type { DeviceListData, ParsedDeviceInfo, USyncQueryResultList } from '../WAUSync'
import { Curve, generateSignalPubKey } from './crypto'
import { encodeBigEndian } from './generics'

function chunk<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size))
	}

	return chunks
}

export const createSignalIdentity = (wid: string, accountSignatureKey: Uint8Array): SignalIdentity => {
	return {
		identifier: { name: wid, deviceId: 0 },
		identifierKey: generateSignalPubKey(accountSignatureKey)
	}
}

export const getPreKeys = async ({ get }: SignalKeyStore, min: number, limit: number) => {
	const idList: string[] = []
	for (let id = min; id < limit; id++) {
		idList.push(id.toString())
	}

	return get('pre-key', idList)
}

export const generateOrGetPreKeys = (creds: AuthenticationCreds, range: number) => {
	const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
	const remaining = range - avaliable
	const lastPreKeyId = creds.nextPreKeyId + remaining - 1
	const newPreKeys: { [id: number]: KeyPair } = {}
	if (remaining > 0) {
		for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
			newPreKeys[i] = Curve.generateKeyPair()
		}
	}

	return {
		newPreKeys,
		lastPreKeyId,
		preKeysRange: [creds.firstUnuploadedPreKeyId, range] as const
	}
}

export const xmppSignedPreKey = (key: SignedKeyPair): BinaryNode => ({
	tag: 'skey',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
		{ tag: 'value', attrs: {}, content: key.keyPair.public },
		{ tag: 'signature', attrs: {}, content: key.signature }
	]
})

export const xmppPreKey = (pair: KeyPair, id: number): BinaryNode => ({
	tag: 'key',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
		{ tag: 'value', attrs: {}, content: pair.public }
	]
})

export const parseAndInjectE2ESessions = async (node: BinaryNode, repository: SignalRepositoryWithLIDStore) => {
	const extractKey = (key: BinaryNode) =>
		key
			? {
					keyId: getBinaryNodeChildUInt(key, 'id', 3)!,
					publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(key, 'value')!),
					signature: getBinaryNodeChildBuffer(key, 'signature')!
				}
			: undefined
	const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user')
	for (const node of nodes) {
		assertNodeErrorFree(node)
	}

	// Most of the work in repository.injectE2ESession is CPU intensive, not IO
	// So Promise.all doesn't really help here,
	// but blocks even loop if we're using it inside keys.transaction, and it makes it "sync" actually
	// This way we chunk it in smaller parts and between those parts we can yield to the event loop
	// It's rare case when you need to E2E sessions for so many users, but it's possible
	const chunkSize = 100
	const chunks = chunk(nodes, chunkSize)

	for (const nodesChunk of chunks) {
		for (const node of nodesChunk) {
			const signedKey = getBinaryNodeChild(node, 'skey')!
			const key = getBinaryNodeChild(node, 'key')!
			const identity = getBinaryNodeChildBuffer(node, 'identity')!
			const jid = node.attrs.jid!

			const registrationId = getBinaryNodeChildUInt(node, 'registration', 4)

			await repository.injectE2ESession({
				jid,
				session: {
					registrationId: registrationId!,
					identityKey: generateSignalPubKey(identity),
					signedPreKey: extractKey(signedKey)!,
					preKey: extractKey(key)!
				}
			})
		}
	}
}

export const extractDeviceJids = (
	result: USyncQueryResultList[],
	myJid: string,
	myLid: string,
	excludeZeroDevices: boolean
) => {
	const { user: myUser, device: myDevice } = jidDecode(myJid)!

	const extracted: FullJid[] = []

	for (const userResult of result) {
		const { devices, id } = userResult as { devices: ParsedDeviceInfo; id: string }
		const { user, domainType, server } = jidDecode(id)!
		const deviceList = devices?.deviceList as DeviceListData[]
		if (Array.isArray(deviceList)) {
			for (const { id: device, keyIndex, isHosted } of deviceList) {
				if (
					(!excludeZeroDevices || device !== 0) && // if zero devices are not-excluded, or device is non zero
					((myUser !== user && myLid !== user) || myDevice !== device) && // either different user or if me user, not this device
					(device === 0 || !!keyIndex) // ensure that "key-index" is specified for "non-zero" devices, produces a bad req otherwise
				) {
					extracted.push({
						user,
						device,
						domainType: isHosted
							? domainType === WAJIDDomains.LID
								? WAJIDDomains.HOSTED_LID
								: WAJIDDomains.HOSTED
							: domainType,
						server
					})
				}
			}
		}
	}

	return extracted
}

/**
 * get the next N keys for upload or processing
 * @param count number of pre-keys to get or generate
 */
export const getNextPreKeys = async ({ creds, keys }: AuthenticationState, count: number) => {
	const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count)

	const update: Partial<AuthenticationCreds> = {
		nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
		firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
	}

	await keys.set({ 'pre-key': newPreKeys })

	const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])

	return { update, preKeys }
}

export const getNextPreKeysNode = async (state: AuthenticationState, count: number) => {
	const { creds } = state
	const { update, preKeys } = await getNextPreKeys(state, count)

	const node: BinaryNode = {
		tag: 'iq',
		attrs: {
			xmlns: 'encrypt',
			type: 'set',
			to: S_WHATSAPP_NET
		},
		content: [
			{ tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
			{ tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
			{ tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
			{ tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k]!, +k)) },
			xmppSignedPreKey(creds.signedPreKey)
		]
	}

	return { update, node }
}



================================================
FILE: src/Utils/use-multi-file-auth-state.ts
================================================
import { Mutex } from 'async-mutex'
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

// We need to lock files due to the fact that we are using async functions to read and write files
// https://github.com/WhiskeySockets/Baileys/issues/794
// https://github.com/nodejs/node/issues/26338
// Use a Map to store mutexes for each file path
const fileLocks = new Map<string, Mutex>()

// Get or create a mutex for a specific file path
const getFileLock = (path: string): Mutex => {
	let mutex = fileLocks.get(path)
	if (!mutex) {
		mutex = new Mutex()
		fileLocks.set(path, mutex)
	}

	return mutex
}

/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
export const useMultiFileAuthState = async (
	folder: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const writeData = async (data: any, file: string) => {
		const filePath = join(folder, fixFileName(file)!)
		const mutex = getFileLock(filePath)

		return mutex.acquire().then(async release => {
			try {
				await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer))
			} finally {
				release()
			}
		})
	}

	const readData = async (file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)
			const mutex = getFileLock(filePath)

			return await mutex.acquire().then(async release => {
				try {
					const data = await readFile(filePath, { encoding: 'utf-8' })
					return JSON.parse(data, BufferJSON.reviver)
				} finally {
					release()
				}
			})
		} catch (error) {
			return null
		}
	}

	const removeData = async (file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)
			const mutex = getFileLock(filePath)

			return mutex.acquire().then(async release => {
				try {
					await unlink(filePath)
				} catch {
				} finally {
					release()
				}
			})
		} catch {}
	}

	const folderInfo = await stat(folder).catch(() => {})
	if (folderInfo) {
		if (!folderInfo.isDirectory()) {
			throw new Error(
				`found something that is not a directory at ${folder}, either delete it or specify a different location`
			)
		}
	} else {
		await mkdir(folder, { recursive: true })
	}

	const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

	const creds: AuthenticationCreds = (await readData('creds.json')) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					await Promise.all(
						ids.map(async id => {
							let value = await readData(`${type}-${id}.json`)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							data[id] = value
						})
					)

					return data
				},
				set: async data => {
					const tasks: Promise<void>[] = []
					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							const file = `${category}-${id}.json`
							tasks.push(value ? writeData(value, file) : removeData(file))
						}
					}

					await Promise.all(tasks)
				}
			}
		},
		saveCreds: async () => {
			return writeData(creds, 'creds.json')
		}
	}
}



================================================
FILE: src/Utils/validate-connection.ts
================================================
import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { proto } from '../../WAProto/index.js'
import {
	KEY_BUNDLE_TYPE,
	WA_ADV_ACCOUNT_SIG_PREFIX,
	WA_ADV_DEVICE_SIG_PREFIX,
	WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
} from '../Defaults'
import type { AuthenticationCreds, SignalCreds, SocketConfig } from '../Types'
import { type BinaryNode, getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary'
import { Curve, hmacSign } from './crypto'
import { encodeBigEndian } from './generics'
import { createSignalIdentity } from './signal'

const getUserAgent = (config: SocketConfig): proto.ClientPayload.IUserAgent => {
	return {
		appVersion: {
			primary: config.version[0],
			secondary: config.version[1],
			tertiary: config.version[2]
		},
		platform: proto.ClientPayload.UserAgent.Platform.WEB,
		releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
		osVersion: '0.1',
		device: 'Desktop',
		osBuildNumber: '0.1',
		localeLanguageIso6391: 'en',

		mnc: '000',
		mcc: '000',
		localeCountryIso31661Alpha2: config.countryCode
	}
}

const PLATFORM_MAP = {
	'Mac OS': proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
	Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN32
}

const getWebInfo = (config: SocketConfig): proto.ClientPayload.IWebInfo => {
	let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
	if (
		config.syncFullHistory &&
		PLATFORM_MAP[config.browser[0] as keyof typeof PLATFORM_MAP] &&
		config.browser[1] === 'Desktop'
	) {
		webSubPlatform = PLATFORM_MAP[config.browser[0] as keyof typeof PLATFORM_MAP]
	}

	return { webSubPlatform }
}

const getClientPayload = (config: SocketConfig) => {
	const payload: proto.IClientPayload = {
		connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: getUserAgent(config)
	}

	payload.webInfo = getWebInfo(config)

	return payload
}

export const generateLoginNode = (userJid: string, config: SocketConfig): proto.IClientPayload => {
	const { user, device } = jidDecode(userJid)!
	const payload: proto.IClientPayload = {
		...getClientPayload(config),
		passive: true,
		pull: true,
		username: +user,
		device: device,
		// TODO: investigate (hard set as false atm)
		lidDbMigrated: false
	}
	return proto.ClientPayload.fromObject(payload)
}

const getPlatformType = (platform: string): proto.DeviceProps.PlatformType => {
	const platformType = platform.toUpperCase()
	return (
		proto.DeviceProps.PlatformType[platformType as keyof typeof proto.DeviceProps.PlatformType] ||
		proto.DeviceProps.PlatformType.CHROME
	)
}

export const generateRegistrationNode = (
	{ registrationId, signedPreKey, signedIdentityKey }: SignalCreds,
	config: SocketConfig
) => {
	// the app version needs to be md5 hashed
	// and passed in
	const appVersionBuf = createHash('md5')
		.update(config.version.join('.')) // join as string
		.digest()

	const companion: proto.IDeviceProps = {
		os: config.browser[0],
		platformType: getPlatformType(config.browser[1]),
		requireFullSync: config.syncFullHistory,
		historySyncConfig: {
			storageQuotaMb: 569150,
			inlineInitialPayloadInE2EeMsg: true,
			supportCallLogHistory: false,
			supportBotUserAgentChatHistory: true,
			supportCagReactionsAndPolls: true,
			supportBizHostedMsg: true,
			supportRecentSyncChunkMessageCountTuning: true,
			supportHostedGroupMsg: true,
			supportFbidBotChatHistory: true,
			supportMessageAssociation: true
		},
		version: {
			primary: 10,
			secondary: 15,
			tertiary: 7
		}
	}

	const companionProto = proto.DeviceProps.encode(companion).finish()

	const registerPayload: proto.IClientPayload = {
		...getClientPayload(config),
		passive: false,
		pull: false,
		devicePairingData: {
			buildHash: appVersionBuf,
			deviceProps: companionProto,
			eRegid: encodeBigEndian(registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature
		}
	}

	return proto.ClientPayload.fromObject(registerPayload)
}

export const configureSuccessfulPairing = (
	stanza: BinaryNode,
	{
		advSecretKey,
		signedIdentityKey,
		signalIdentities
	}: Pick<AuthenticationCreds, 'advSecretKey' | 'signedIdentityKey' | 'signalIdentities'>
) => {
	const msgId = stanza.attrs.id

	const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success')

	const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity')
	const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform')
	const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device')
	const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz')

	if (!deviceIdentityNode || !deviceNode) {
		throw new Boom('Missing device-identity or device in pair success node', { data: stanza })
	}

	const bizName = businessNode?.attrs.name
	const jid = deviceNode.attrs.jid
	const lid = deviceNode.attrs.lid

	const { details, hmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content as Buffer)

	let hmacPrefix = Buffer.from([])
	if (accountType !== undefined && accountType === proto.ADVEncryptionType.HOSTED) {
		hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
	}

	const advSign = hmacSign(Buffer.concat([hmacPrefix, details!]), Buffer.from(advSecretKey, 'base64'))
	if (Buffer.compare(hmac!, advSign) !== 0) {
		throw new Boom('Invalid account signature')
	}

	const account = proto.ADVSignedDeviceIdentity.decode(details!)
	const { accountSignatureKey, accountSignature, details: deviceDetails } = account

	const deviceIdentity = proto.ADVDeviceIdentity.decode(deviceDetails!)

	const accountSignaturePrefix =
		deviceIdentity.deviceType === proto.ADVEncryptionType.HOSTED
			? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
			: WA_ADV_ACCOUNT_SIG_PREFIX
	const accountMsg = Buffer.concat([accountSignaturePrefix, deviceDetails!, signedIdentityKey.public])
	if (!Curve.verify(accountSignatureKey!, accountMsg, accountSignature!)) {
		throw new Boom('Failed to verify account signature')
	}

	const deviceMsg = Buffer.concat([
		WA_ADV_DEVICE_SIG_PREFIX,
		deviceDetails!,
		signedIdentityKey.public,
		accountSignatureKey!
	])
	account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg)

	const identity = createSignalIdentity(lid!, accountSignatureKey!)
	const accountEnc = encodeSignedDeviceIdentity(account, false)

	const reply: BinaryNode = {
		tag: 'iq',
		attrs: {
			to: S_WHATSAPP_NET,
			type: 'result',
			id: msgId!
		},
		content: [
			{
				tag: 'pair-device-sign',
				attrs: {},
				content: [
					{
						tag: 'device-identity',
						attrs: { 'key-index': deviceIdentity.keyIndex!.toString() },
						content: accountEnc
					}
				]
			}
		]
	}

	const authUpdate: Partial<AuthenticationCreds> = {
		account,
		me: { id: jid!, name: bizName, lid },
		signalIdentities: [...(signalIdentities || []), identity],
		platform: platformNode?.attrs.name
	}

	return {
		creds: authUpdate,
		reply
	}
}

export const encodeSignedDeviceIdentity = (account: proto.IADVSignedDeviceIdentity, includeSignatureKey: boolean) => {
	account = { ...account }
	// set to null if we are not to include the signature key
	// or if we are including the signature key but it is empty
	if (!includeSignatureKey || !account.accountSignatureKey?.length) {
		account.accountSignatureKey = null
	}

	return proto.ADVSignedDeviceIdentity.encode(account).finish()
}



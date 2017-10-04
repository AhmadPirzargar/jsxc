import Storage from '../Storage';
import Log from '../util/Log';
import Contact from '../Contact'
import Menu from './util/Menu'
import Options from '../Options'
import Message from '../Message'
import Client from '../Client'
import Account from '../Account'
import * as CONST from '../CONST'
import DateTime from './util/DateTime'
import showVerificationDialog from './dialogs/verification'
import showFingerprintsDialog from './dialogs/fingerprints'
import Emoticons from '../Emoticons'
import SortedPersistentMap from '../util/SortedPersistentMap'
import PersistentMap from '../util/PersistentMap'
import Avatar from './Avatar'
import 'simplebar'
import {startCall} from './actions/call'
import {Presence} from '../connection/AbstractConnection'
import Pipe from '../util/Pipe'
import {EncryptionState} from '../plugin/AbstractPlugin'
import ElementHandler from './util/ElementHandler'
import JID from '../JID'

let chatWindowTemplate = require('../../template/chatWindow.hbs');

const ENTER_KEY = 13;
const ESC_KEY = 27;

export default class ChatWindow {
   protected element;

   private inputElement;

   private inputBlurTimeout:number;

   private storage;

   private readonly INPUT_RESIZE_DELAY = 1200;

   private readonly HIGHTLIGHT_DURATION = 600;

   private properties:PersistentMap;

   private messages:SortedPersistentMap;

   constructor(protected account:Account, protected contact:Contact) {
      let template = chatWindowTemplate({
         accountId: account.getUid(),
         contactId: contact.getId(),
         name: contact.getName()
      });
      this.element = $(template);
      this.inputElement = this.element.find('.jsxc-message-input');

      this.storage = account.getStorage();

      Menu.init(this.element.find('.jsxc-menu'));

      this.initResizableWindow();
      this.initEmoticonMenu();
      this.restoreLocalHistory();
      this.registerHandler();
      this.registerInputHandler();

      this.element.find('.jsxc-name').disableSelection();
      this.element.find('.jsxc-window').css('bottom', -1 * this.element.find('.jsxc-window-fade').height());

      this.messages.registerHook((newMessages, oldMessages) => {
         oldMessages = oldMessages || [];

         if (newMessages.length === 0 && oldMessages.length > 0) {
            this.clear();
         } // else if(newMessages.length > oldMessages.length) {
         //    let diff = $(newMessages).not(oldMessages).get();
         //
         //    for (let messageId of diff) {
         //       this.postMessage(new Message(messageId));
         //    }
         // }
      });

      this.properties = new PersistentMap(this.storage, 'chatWindow', this.contact.getId());

      if (this.properties.get('minimized') === false) {
         this.unminimize();
      } else {
         this.minimize();
      }

      this.properties.registerHook('minimized', (minimized) => { console.log('properties.minimized')
         if (minimized) {
            this.minimize();
         } else {
            this.unminimize();
         }
      });

      let avatar = Avatar.get(contact);
      avatar.addElement(this.element.find('.jsxc-window-bar .jsxc-avatar'));

      // @TODO update gui
      this.contact.registerHook('name', (newName) => {
         this.element.find('.jsxc-name').text(newName);
      });

      this.contact.registerHook('encryptionState', this.updateEncryptionState);
      this.updateEncryptionState(this.contact.getEncryptionState());

      let pluginRepository = this.account.getPluginRepository();
      if (pluginRepository.hasEncryptionPlugin()) {
         let transferElement = this.getDom().find('.jsxc-transfer');

         transferElement.removeClass('jsxc-disabled');
         transferElement.click(() => {
            //@TODO create selection
            pluginRepository.getEncryptionPlugin('otr').toggleTransfer(this.contact);
         })
      }

      this.element.attr('data-presence', Presence[this.contact.getPresence()]);

      this.contact.registerHook('presence', (newPresence) => {
         this.element.attr('data-presence', Presence[newPresence]);
      });

      setTimeout(() => {
         this.scrollMessageAreaToBottom();
      }, 500);
   }

   public getId() {
      return /*this.account.getUid() + '@' +*/ this.contact.getId();
   }

   public getAccount() {
      return this.account;
   }

   public getContact() {
      return this.contact;
   }

   public getDom() {
      return this.element;
   }

   public close() {
      this.element.remove();
   }

   public minimize(ev?) {
      this.element.removeClass('jsxc-normal').addClass('jsxc-minimized');

      this.properties.set('minimized', true);

      //@TODO replace this with max-height css property
      //win.find('.jsxc-window').css('bottom', -1 * win.find('.jsxc-window-fade').height());
   }

   public unminimize(ev?) {
      let element = this.element;

      if (Client.isExtraSmallDevice()) {
         if (parseFloat($('#jsxc-roster').css('right')) >= 0) {
            // duration = jsxc.gui.roster.toggle();
         }

         //@TODO hide all other windows
         //@TODO fullscreen this window
      }

      element.removeClass('jsxc-minimized').addClass('jsxc-normal');

      this.properties.set('minimized', false);

      // @REVIEW is this still required?
      //element.find('.jsxc-window').css('bottom', '0');

      //@TODO scroll message list, so that this window is in the view port

      this.scrollMessageAreaToBottom();

      if (ev && ev.target) {
         element.find('.jsxc-textinput').focus();
      }
   }

   public clear() {
      this.messages.empty(function(id, message){ console.log(id, message)
         message.delete();
      })

      this.element.find('.jsxc-message-area').empty();
   }

   public highlight() {
      let element = this.element;

      if (!element.hasClass('jsxc-highlight')) {
         element.addClass('jsxc-highlight');

         setTimeout(function(){
            element.removeClass('jsxc-highlight');
         }, this.HIGHTLIGHT_DURATION)
      }
   }

   public addSystemMessage(messageString:string) {
      let message = new Message({
         peer: this.contact.getJid(),
         direction: Message.DIRECTION.SYS,
         plaintextMessage: messageString
      });
      message.save();
      this.receiveIncomingMessage(message);
   }

   public receiveIncomingMessage(message:Message) {
      this.messages.push(message);
   }

   public postMessage(message:Message) {
      if (message.getDirection() === Message.DIRECTION.IN && !this.inputElement.is(':focus')) {
         message.setUnread();
      }

      let messageElement = $('<div>');
      messageElement.addClass('jsxc-chatmessage jsxc-' + message.getDirectionString());
      messageElement.attr('id', message.getCssId());
      messageElement.html('<div>' + message.getProcessedBody() + '</div>');

      let timestampElement = $('<div>');
      timestampElement.addClass('jsxc-timestamp');
      DateTime.stringify(message.getStamp(), timestampElement);
      messageElement.append(timestampElement);

      if (message.isReceived()) {
         messageElement.addClass('jsxc-received');
      } else {
         messageElement.removeClass('jsxc-received');
      }

      if (message.isForwarded()) {
         messageElement.addClass('jsxc-forwarded');
      } else {
         messageElement.removeClass('jsxc-forwarded');
      }

      if (message.isEncrypted()) {
         messageElement.addClass('jsxc-encrypted');
      } else {
         messageElement.removeClass('jsxc-encrypted');
      }

      if (message.getErrorMessage()) {
         messageElement.addClass('jsxc-error');
         messageElement.attr('title', message.getErrorMessage());
      } else {
         messageElement.removeClass('jsxc-error');
      }

      if (message.hasAttachment()) {
         let attachment = message.getAttachment();
         let mimeType = attachment.getMimeType();
         let attachmentElement = $('<div>');
         attachmentElement.addClass('jsxc-attachment');
         attachmentElement.addClass('jsxc-' + mimeType.replace(/\//, '-'));
         attachmentElement.addClass('jsxc-' + mimeType.replace(/^([^/]+)\/.*/, '$1'));

         if (attachment.isPersistent()) {
            attachmentElement.addClass('jsxc-persistent');
         }

         if (attachment.isImage() && attachment.hasThumbnailData()) {
            $('<img>')
               .attr('alt', 'preview')
               .attr('src', attachment.getThumbnailData())
               // .attr('title', message.getName())
               .appendTo(attachmentElement);
         } else {
            attachmentElement.text(attachment.getName());
         }

         if (attachment.hasData()) {
            attachmentElement = $('<a>').append(attachmentElement);
            attachmentElement.attr('href', attachment.getData());
            attachmentElement.attr('download', attachment.getName());
         }

         messageElement.find('div').first().append(attachmentElement);
      }

      if (message.getDirection() === Message.DIRECTION.SYS) {
         this.element.find('.jsxc-message-area').append('<div class="jsxc-clear"/>');
      } else {
         //@TODO update last message
         //$('[data-bid="' + bid + '"]').find('.jsxc-lastmsg .jsxc-text').html(msg);
      }

      if (message.getDOM().length > 0) {
         message.getDOM().replaceWith(messageElement);
      } else {
         this.element.find('.jsxc-message-area').append(messageElement);
      }

      let sender = message.getSender();
      if (typeof sender.name === 'string') {
         let title = sender.name;

         if (sender.jid instanceof JID) {
            messageElement.attr('data-bid', sender.jid.bare); //@REVIEW required?

            title += '\n' + sender.jid.bare;
         }

         timestampElement.text(sender.name + ': ' + timestampElement.text());

         let avatarElement = $('<div>');
         avatarElement.addClass('jsxc-avatar');
         avatarElement.attr('title', title); //@REVIEW escape?

         messageElement.prepend(avatarElement)
         messageElement.attr('data-name', sender.name);

         if (messageElement.prev().length > 0 && messageElement.prev().find('.jsxc-avatar').attr('title') === avatarElement.attr('title')) {
            avatarElement.css('visibility', 'hidden');
         }

         Avatar.setPlaceholder(avatarElement, sender.name);
      }

      this.scrollMessageAreaToBottom();
   }

   protected addActionEntry(className:string, cb:(ev)=>void) { console.log('addActionEntry')
      let element = $('<div>');
      element.addClass(className);
      element.on('click', cb);

      this.element.find('.jsxc-tools .jsxc-close').before(element);
   }

   protected addMenuEntry(className:string, label:string, cb:(ev)=>void) { console.log('addMenuEntry')
      let element = $('<a>');
      element.attr('href', '#');
      element.addClass(className);
      element.text(label);
      element.on('click', cb);

      this.element.find('.jsxc-tools .jsxc-menu ul').append($('<li>').append(element));
   }

   private registerHandler() {
      let self = this;
      let contact = this.contact;
      let elementHandler = new ElementHandler(contact);

      elementHandler.add(
         this.element.find('.jsxc-verification')[0],
         function() {
            showVerificationDialog(contact);
         }
      );

      elementHandler.add(
         this.element.find('.jsxc-fingerprints')[0],
         function() {
            showFingerprintsDialog(contact);
         }
      );

      elementHandler.add(
         this.element.find('.jsxc-window-bar')[0],
         () => {
            this.toggle();
         }
      );

      elementHandler.add(
         this.element.find('.jsxc-close')[0],
         () => {
            this.account.closeChatWindow(this);
         }
      );

      elementHandler.add(
         this.element.find('.jsxc-clear')[0],
         () => {
            this.clear();
         }
      );

      elementHandler.add(
         this.element.find('.jsxc-video')[0],
         (ev) => {
            ev.stopPropagation();

            startCall(contact, this.account);
         }, [
            'urn:xmpp:jingle:apps:rtp:video',
            'urn:xmpp:jingle:apps:rtp:audio',
            'urn:xmpp:jingle:transports:ice-udp:1',
            'urn:xmpp:jingle:apps:dtls:0'
         ]
      );

      elementHandler.add(
         this.element.find('.jsxc-sendFile')[0],
         function() {
            $('body').click();

            // jsxc.gui.window.sendFile(bid);
         }
      );

      elementHandler.add(
         this.element.find('.jsxc-message-area')[0],
         function() {
            // check if user clicks element or selects text
            if (typeof getSelection === 'function' && !getSelection().toString()) {
               self.inputElement.focus();
            }
         }
      );
   }

   private registerInputHandler() {
      let self = this;
      var textinputBlurTimeout;
      let inputElement = this.inputElement;

      inputElement.keyup(self.onInputKeyUp);
      inputElement.keypress(self.onInputKeyPress);
      inputElement.focus(this.onInputFocus);
      inputElement.blur(this.onInputBlur);

      // @REVIEW
      inputElement.mouseenter(function() {
         $('#jsxc-window-list').data('isHover', true);
      }).mouseleave(function() {
         $('#jsxc-window-list').data('isHover', false);
      });
   }

   private onInputKeyUp = (ev) => {
      var message = $(ev.target).val();

      if (ev.which === ENTER_KEY && !ev.shiftKey) {
         message = '';
      } else {
         this.resizeInputArea();
      }

      if (ev.which === ESC_KEY) {
         this.close();
      }
   }

   private onInputKeyPress = (ev) => {
      let message:string = <string>$(ev.target).val();

      if (ev.which !== ENTER_KEY || ev.shiftKey || !message) {
         return;
      }

      this.sendOutgoingMessage(message);

      // reset textarea
      $(ev.target).css('height', '').val('');

      ev.preventDefault();
   }

   private onInputFocus = () => {
      if (this.inputBlurTimeout) {
         clearTimeout(this.inputBlurTimeout);
      }

      // remove unread flag
      //jsxc.gui.readMsg(bid);

      this.resizeInputArea();
   }

   private onInputBlur = (ev) => {
      this.inputBlurTimeout = setTimeout(function() {
         $(ev.target).css('height', '');
      }, this.INPUT_RESIZE_DELAY);
   }

   private sendOutgoingMessage(messageString:string) {
      if (this.contact.isEncrypted()) {
         //@TODO send sys $.t('your_message_wasnt_send_please_end_your_private_conversation');
         return;
      }
//@TODO we need a full jid
      let message = new Message({
         peer: this.contact.getJid(),
         direction: Message.DIRECTION.OUT,
         type: this.contact.getType(),
         plaintextMessage: messageString
      });

      let pipe = Pipe.get('preSendMessage');

      pipe.run(this.contact, message).then(([contact, message]) => {
         message.save();

         this.messages.push(message);

         this.getAccount().getConnection().sendMessage(message);
      });

      if (messageString === '?' && Options.get('theAnswerToAnything') !== false) {
         if (typeof Options.get('theAnswerToAnything') === 'undefined' || (Math.random() * 100 % 42) < 1) {
            Options.set('theAnswerToAnything', true);

            (new Message({
               peer: this.contact.getJid(),
               direction: Message.DIRECTION.SYS,
               plaintextMessage: '42'
            })).save();
         }
      }
   }

   private toggle = (ev?) => {
      if (this.element.hasClass('jsxc-minimized')) {
         this.unminimize(ev);
      } else {
         this.minimize(ev);
      }
   }

   private updateEncryptionState = (encryptionState) => {
      Log.debug('update window encryption state');

      let transferElement = this.getDom().find('.jsxc-transfer');
      transferElement.removeClass('jsxc-fin jsxc-enc jsxc-trust');

      switch(encryptionState) {
         case EncryptionState.Plaintext:
            break;
         case EncryptionState.UnverifiedEncrypted:
            transferElement.addClass('jsxc-enc');
            break;
         case EncryptionState.VerifiedEncrypted:
            transferElement.addClass('jsxc-enc jsxc-trust');
            break;
         case EncryptionState.Ended:
            transferElement.addClass('jsxc-fin');
            break;
         default:
            Log.warn('Unknown encryption state');
      }
   }

   private resizeInputArea() {
      let inputElement = this.inputElement;

      if (!inputElement.data('originalHeight')) {
         inputElement.data('originalHeight', inputElement.outerHeight());
      }

      // compensate rounding error
      if (inputElement.outerHeight() < (inputElement[0].scrollHeight - 1) && inputElement.val()) {
         inputElement.height(inputElement.data('originalHeight') * 1.5);
      }
   }

   private initResizableWindow() {
      let element = this.element;

      element.find('.jsxc-message-area').resizable({
         handles: 'w, nw, n',
         minHeight: 234,
         minWidth: 250,
         resize: function(ev, ui) {
            //jsxc.gui.window.resize(element, ui);
         },
         start: function() {
            element.removeClass('jsxc-normal');
         },
         stop: function() {
            element.addClass('jsxc-normal');
         }
      });
   }

   private initEmoticonMenu() {
      let emoticonListElement = this.element.find('.jsxc-menu-emoticons ul');
      let emoticonList = Emoticons.getDefaultEmoticonList();

      emoticonList.forEach(emoticon => {
         var li = $('<li>');

         li.append(Emoticons.toImage(emoticon));
         li.find('div').attr('title', emoticon);
         li.click(() => {
           let inputElement = this.element.find('.jsxc-message-input');
           let inputValue = inputElement.val() || '';
           let selectionStart = inputElement[0].selectionStart;
           let selectionEnd = inputElement[0].selectionEnd;
           let inputStart = inputValue.slice(0, selectionStart);
           let inputEnd = inputValue.slice(selectionEnd);

           let newValue = inputStart;
           newValue += (inputStart.length && inputStart.slice(-1) !== ' ')? ' ' : '';
           newValue += emoticon;
           newValue += (inputEnd.length && inputEnd.slice(0, 1) !== ' ')? ' ' : '';
           newValue += inputEnd;

           inputElement.val(newValue);
           inputElement.focus();
         });

         emoticonListElement.prepend(li);
      });
   }

   private restoreLocalHistory() {
      this.messages = new SortedPersistentMap(this.storage, 'history', this.contact.getId());
      this.messages.setPushHook(uid => {
         let message = new Message(uid);

         this.postMessage(message);

         return message;
      });
      this.messages.init();
   }

   private resizeMessageArea(width?:number, height?:number, outer?) {
      let element = this.element;

      if (!element.attr('data-default-height')) {
         element.attr('data-default-height', element.find('.ui-resizable').height());
      }

      if (!element.attr('data-default-width')) {
         element.attr('data-default-width', element.find('.ui-resizable').width());
      }

      //@REVIEW ???
      var outerHeightDiff = (outer) ? element.find('.jsxc-window').outerHeight() - element.find('.ui-resizable').height() : 0;

      width = width || parseInt(element.attr('data-default-width'));
      height = height || parseInt(element.attr('data-default-height')) + outerHeightDiff;

      if (outer) {
         height -= outerHeightDiff;
      }

      element.width(width);

      // @TODO we don't use slimscroll anymore
      element.find('.jsxc-message-area').slimScroll({
         height: height
      });

      $(document).trigger('resize.window.jsxc', [this]);
   }

   private fullsizeMessageArea() {
      let size:{width:number, height:number} = Options.get('viewport').getSize();
      let barHeight = this.element.find('.jsxc-window-bar').outerHeight();
      let inputHeight = this.inputElement.outerHeight();

      size.width -= 10;
      size.height -= barHeight + inputHeight;

      this.resizeMessageArea(size.width, size.height);
   }

   private scrollMessageAreaToBottom() {
      let messageArea = this.element.find('.jsxc-message-area');

      messageArea[0].scrollTop = messageArea[0].scrollHeight;
   }
}

// w = {
//
//    updateProgress: function(message, sent, size) {
//       var div = message.getDOM();
//       var span = div.find('.jsxc-timestamp span');
//
//       if (span.length === 0) {
//          div.find('.jsxc-timestamp').append('<span>');
//          span = div.find('.jsxc-timestamp span');
//       }
//
//       span.text(' ' + Math.round(sent / size * 100) + '%');
//
//       if (sent === size) {
//          span.remove();
//       }
//    },
//
//    showOverlay: function(bid, content, allowClose) {
//       var win = jsxc.gui.window.get(bid);
//
//       win.find('.jsxc-overlay .jsxc-body').empty().append(content);
//       win.find('.jsxc-overlay .jsxc-close').off('click').click(function() {
//          jsxc.gui.window.hideOverlay(bid);
//       });
//
//       if (allowClose !== true) {
//          win.find('.jsxc-overlay .jsxc-close').hide();
//       } else {
//          win.find('.jsxc-overlay .jsxc-close').show();
//       }
//
//       win.addClass('jsxc-showOverlay');
//    },
//
//    hideOverlay: function(bid) {
//       var win = jsxc.gui.window.get(bid);
//
//       win.removeClass('jsxc-showOverlay');
//    },
//
//    selectResource: function(bid, text, cb, res) {
//       res = res || jsxc.storage.getUserItem('res', bid) || [];
//       cb = cb || function() {};
//
//       if (res.length > 0) {
//          var content = $('<div>');
//          var list = $('<ul>'),
//             i, li;
//
//          for (i = 0; i < res.length; i++) {
//             li = $('<li>');
//
//             li.append($('<a>').text(res[i]));
//             li.appendTo(list);
//          }
//
//          list.find('a').click(function(ev) {
//             ev.preventDefault();
//
//             jsxc.gui.window.hideOverlay(bid);
//
//             cb({
//                status: 'selected',
//                result: $(this).text()
//             });
//          });
//
//          if (text) {
//             $('<p>').text(text).appendTo(content);
//          }
//
//          list.appendTo(content);
//
//          jsxc.gui.window.showOverlay(bid, content);
//       } else {
//          cb({
//             status: 'unavailable'
//          });
//       }
//    },
//
//    smpRequest: function(bid, question) {
//       var content = $('<div>');
//
//       var p = $('<p>');
//       p.text($.t('smpRequestReceived'));
//       p.appendTo(content);
//
//       var abort = $('<button>');
//       abort.text($.t('Abort'));
//       abort.click(function() {
//          jsxc.gui.window.hideOverlay(bid);
//          jsxc.storage.removeUserItem('smp', bid);
//
//          if (jsxc.master && jsxc.otr.objects[bid]) {
//             jsxc.otr.objects[bid].sm.abort();
//          }
//       });
//       abort.appendTo(content);
//
//       var verify = $('<button>');
//       verify.text($.t('Verify'));
//       verify.addClass('jsxc-btn jsxc-btn-primary');
//       verify.click(function() {
//          jsxc.gui.window.hideOverlay(bid);
//
//          jsxc.otr.onSmpQuestion(bid, question);
//       });
//       verify.appendTo(content);
//
//       jsxc.gui.window.showOverlay(bid, content);
//    },
//
//    sendFile: function(jid) {
//       jsxc.fileTransfer.startGuiAction(jid);
//    }
// };

const shortid = require('shortid')

const applicationStatus = {
  plugin: {
    name: 'applicationStatus',
    dependencies: 'vision',
    multiple: true,
    register: (server) => {
      server.route({
        method: 'get',
        path: '/status',
        handler: async (request, h) => {
          // eslint-disable-next-line no-unused-vars
          const { notifyService, payService, emailService, webhookService, cacheService, sheetsService } = request.services([])
          const { pay, reference, outputs, webhookData } = await cacheService.getState(request)
          const params = request.query
          let newReference
          let payState
          let userCouldntPay

          if (pay) {
            const { self, meta } = pay
            payState = await payService.payStatus(self, meta.payApiKey)
            userCouldntPay = (params.continue === 'true') || pay.meta.attempts === 3

            /**
             * @code allow the user to try again if they haven't skipped or reached their retry limit
             */
            if (payState.state.status !== 'success' && !userCouldntPay) {
              return h.view('pay-error', { reference, errorList: ['there was a problem with your payment'] })
            }
          }

          if (reference) {
            await cacheService.clearState(request)
            if (reference !== 'UNKNOWN') {
              return h.view('confirmation', { reference })
            } else {
              return h.view('confirmation')
            }
          }

          /**
           * @code if there are webhooks, find one and use that to generate a reference number for other output calls.
           * TODO:- to be honest, it should really be a 'lazy' var but concurrent aysnc is kinda a pain for this and I don't have time. Probably wont have >1 webhook anyway. ¯\_( ツ )_/¯
           */
          const webhookOutputs = (outputs || []).filter(output => output.type === 'webhook')
          let firstWebhook

          try {
            if (webhookOutputs.length) {
              firstWebhook = webhookOutputs[0]
              const firstWebhookFormData = webhookData
              if (userCouldntPay && firstWebhookFormData.fees) {
                delete firstWebhookFormData.fees
              }
              newReference = await webhookService.postRequest(firstWebhook.outputData.url, firstWebhookFormData)
              await cacheService.mergeState(request, { reference: newReference })
            }
            /* eslint-disable no-case-declarations */
            const outputPromises = (outputs || []).filter(output => output !== firstWebhook).map(output => {
              switch (output.type) {
                case 'email':
                  const { emailAddress, attachments } = output.outputData
                  return emailService.sendEmail(emailAddress, 'subject', { attachments })
                case 'notify':
                  const { apiKey, templateId, personalisation, emailField } = output.outputData
                  return notifyService.sendNotification(apiKey, templateId, emailField, newReference, personalisation || {})
                case 'webhook':
                  const { url } = output.outputData
                  const formData = webhookData
                  if (userCouldntPay) {
                    delete formData.fees
                  }
                  return webhookService.postRequest(url, formData)
                case 'sheets':
                  const { spreadsheetId, data, authOptions } = output.outputData
                  return sheetsService.appendTo(spreadsheetId, data, authOptions)
              }
            })
            /* eslint-enable no-case-declarations */

            if (outputPromises.length) {
              await Promise.all(outputPromises)
            }
            await cacheService.clearState(request)
            if (newReference !== 'UNKNOWN') {
              return h.view('confirmation', { reference: newReference, paySkipped: userCouldntPay })
            } else {
              return h.view('confirmation', { paySkipped: userCouldntPay })
            }
          } catch (err) {
            request.server.log(['error', 'output'], `Error processing output: ${err.message}`)
            await cacheService.clearState(request)
            return h.view('application-error')
          }

          // TODO:- unfinished pay flow?
        }

      })
      server.route({
        method: 'post',
        path: '/status',
        handler: async (request, h) => {
          const { payService, cacheService } = request.services([])
          const { pay } = await cacheService.getState(request)
          const { meta } = pay
          meta.attempts++
          // TODO:- let payService handle shortid.generate()
          const reference = `FCO-${shortid.generate()}`
          const res = await payService.payRequest(meta.amount, reference, meta.description, meta.payApiKey)
          await cacheService.mergeState(request, { pay: { payId: res.payment_id, reference, self: res._links.self.href, meta } })
          return h.redirect(res._links.next_url.href)
        }
      })
    }
  }
}

module.exports = applicationStatus

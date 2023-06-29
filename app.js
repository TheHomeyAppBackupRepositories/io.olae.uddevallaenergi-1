'use strict';

const Homey = require('homey');
const https = require('https');

class UddevallaEnergi extends Homey.App {

  async onInit() {
    this.log('Uddevalla Energi app has been initialized');

    this.newDatesForPickupTrigger = this.homey.flow.getTriggerCard('new-dates-for-pickup');
    this.pickupTomorrowCondition = await this.homey.flow.getConditionCard('pickup-tomorrow');

    this.matavfallToken = await this.homey.flow.createToken('next_matavfall', {
      type: 'string',
      title: this.homey.__('tokens.next_matavfall'),
    });

    this.restavfallToken = await this.homey.flow.createToken('next_restavfall', {
      type: 'string',
      title: this.homey.__('tokens.next_restavfall'),
    });

    // Returns true if 6am pickup is less than 24 hours away
    this.pickupTomorrowCondition.registerRunListener(async (args, state) => {
      const dateNow = new Date();
      const dateMatavfall = new Date(this.homey.settings.get('matavfall'));
      const dateRestavfall = new Date(this.homey.settings.get('restavfall'));
      const datePickup = dateMatavfall < dateRestavfall ? dateMatavfall : dateRestavfall;

      // Pickup is from 6am
      datePickup.setHours(6);
      datePickup.setMinutes(0);
      datePickup.setSeconds(0);

      // Calculate time until next pickup
      const diff = datePickup.getTime() - dateNow.getTime();

      // Detect if pickup date has been passed and report this
      if (diff <= 0) {
        this.log('WARNING: The time for next pickup is outdated.');
        this.homey.notifications.createNotification({ excerpt: `Uddevalla Energi: ${this.homey.__('notifications.next_date_in_past')}` });
        return false;
      }

      // Less than 24 hours before pickup time. 24h * 60m * 60s * 1000 ms = 86400000
      if (diff < 86400000) {
        this.log('Less than 24 hours until next pickup, returning true');
        return 1;
      }

      this.log('More than 24 hours until next pickup, returning false');
      return false;
    });

    // Update pickup dates on app startup
    if (this.homey.settings.getKeys().includes('plantnumber') && this.homey.settings.get('plantnumber') > 0) {
      this.fetchPickupDates(this.homey.settings.get('plantnumber'));
    } else {
      this.log('No valid street address configured, please review app settings!');
      this.homey.notifications.createNotification({ excerpt: `Uddevalla Energi: ${this.homey.__('notifications.no_street_address')}` });
    }

    // Create update schedule
    this.homey.setInterval(() => {
      this.fetchPickupDates(this.homey.settings.get('plantnumber'));
    }, 43200000); // 12h

    this.homey.settings.on('set', key => {
      // New street address
      if (key === 'streetaddress') {
        const streetaddress = this.homey.settings.get('streetaddress');
        https.get(`https://app.uddevallaenergi.se/wp-json/app/v1/address?address=${streetaddress}`, res => {
          let body = '';
          let plantnumber = 0;

          res.on('data', chunk => {
            body += chunk;
          }).on('end', () => {
            if (body.length > 0) {
              body = JSON.parse(body);
              plantnumber = body[0].plant_number;
              this.log(`Updated address "${streetaddress}" resolved to plant number ${plantnumber}`);
            } else {
              this.log(`Was unable to fetch a plant number for address ${streetaddress}. App will not function correctly!`);
              this.homey.notifications.createNotification({ excerpt: `Uddevalla Energi: ${this.homey.__('notifications.no_plant', { address: streetaddress })}` });
            }

            this.homey.settings.set('plantnumber', plantnumber); // Might be zero on error
          });
        }).on('error', e => {
          this.log(`There was an error fetching plant number for address: ${e.message}`);
          this.homey.notifications.createNotification({ excerpt: `Uddevalla Energi: ${this.homey.__('notifications.fetch_plant_error', { error: e.message })}` });
          this.homey.settings.set('plantnumber', -1); // Indicate fetch error
        });
      }

      // New plantnumber
      if (key === 'plantnumber') {
        const plantnumber = this.homey.settings.get('plantnumber');
        if (plantnumber > 0) {
          this.fetchPickupDates(plantnumber);
        }
      }

      // Matavfall or Restavfall
      if (key === 'matavfall') {
        this.log(`New date for ${key}: ${this.homey.settings.get(key)}`);
        this.matavfallToken.setValue(this.homey.settings.get(key));
      }
      if (key === 'restavfall') {
        this.log(`New date for ${key}: ${this.homey.settings.get(key)}`);
        this.restavfallToken.setValue(this.homey.settings.get(key));
      }
    });
  }

  async fetchPickupDates(plantnumber) {
    this.log(`Updating dates for plant number ${plantnumber}`);
    const url = `https://app.uddevallaenergi.se/wp-json/app/v1/next-pickup-web?plant_number=${plantnumber}`;
    https.get(url, res => {
      let body = '';

      res.on('data', chunk => {
        body += chunk;
      }).on('end', () => {
        body = JSON.parse(body);
        let updated = 0;
        body.forEach(e => {
          const v = e.type.toLowerCase();
          const d = e.pickup_date;
          if (d !== this.homey.settings.get(v)) {
            this.homey.settings.set(v, d);
            updated = 1;
          }
        });

        // Trigger flows if updated
        if (updated) {
          const tokens = {
            restavfall: this.homey.settings.get('restavfall'),
            matavfall: this.homey.settings.get('matavfall'),
          };
          this.newDatesForPickupTrigger.trigger(tokens)
            .catch(this.error)
            .then(this.log('new-dates-for-pickup triggered'));
        }
      });
    });
  }

}

module.exports = UddevallaEnergi;

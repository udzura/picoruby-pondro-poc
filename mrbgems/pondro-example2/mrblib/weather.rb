module Example2
  module Weather
    DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum']

    def self.forecast(bindings, args)
      location = args['location'].strip
      prefecture = args['prefecture']
      days = args['days'] || 3
      raise ArgumentError, 'Location must be 1 to 128 bytes' if location.empty? || location.bytesize > 128
      if prefecture && (prefecture.strip.empty? || prefecture.bytesize > 128)
        raise ArgumentError, 'Prefecture must be 1 to 128 bytes'
      end
      places = json(bindings, 'https://geocoding-api.open-meteo.com/v1/search?name=' + encode(location) +
                    '&count=10&language=ja&countryCode=JP')['results'] || []
      raise Pondro::BindingError, 'Invalid geocoding results' unless places.is_a?(Array)
      places = places.select { |place| place.is_a?(Hash) && place['country_code'] == 'JP' }
      places = places.select { |place| place['admin1'] == prefecture.strip } if prefecture
      return { 'status' => 'not_found', 'message' => 'Try a romanized city name and its Japanese prefecture.' } if places.empty?
      if places.length > 1
        return { 'status' => 'ambiguous', 'message' => 'Specify the prefecture or a more precise city name.',
                 'candidates' => places.map { |place| { 'name' => place['name'], 'prefecture' => place['admin1'] } } }
      end
      place = places[0]
      unless place['latitude'].is_a?(Numeric) && place['longitude'].is_a?(Numeric)
        raise Pondro::BindingError, 'Invalid geocoding coordinates'
      end
      data = json(bindings, 'https://api.open-meteo.com/v1/forecast?latitude=' + place['latitude'].to_s +
                  '&longitude=' + place['longitude'].to_s + '&timezone=Asia%2FTokyo&forecast_days=' + days.to_s +
                  '&daily=' + DAILY.join(','))
      daily = data['daily']
      unless daily.is_a?(Hash) && daily['time'].is_a?(Array) && daily['time'].length == days &&
             DAILY.all? { |key| daily[key].is_a?(Array) && daily[key].length == days }
        raise Pondro::BindingError, 'Invalid Open-Meteo daily forecast'
      end
      forecast = Array.new(days) do |index|
        date = daily['time'][index]
        raise Pondro::BindingError, 'Invalid forecast date' unless date.is_a?(String)
        row = { 'date' => date }
        DAILY.each do |key|
          value = daily[key][index]
          raise Pondro::BindingError, 'Invalid forecast value' unless value.nil? || value.is_a?(Numeric)
          row[key] = value
        end
        row
      end
      { 'status' => 'ok', 'source' => 'Open-Meteo (geocoding: GeoNames)',
        'location' => { 'name' => place['name'], 'prefecture' => place['admin1'],
                        'latitude' => place['latitude'], 'longitude' => place['longitude'] },
        'timezone' => 'Asia/Tokyo', 'units' => { 'weather_code' => 'WMO code',
        'temperature_2m_max' => '°C', 'temperature_2m_min' => '°C', 'precipitation_sum' => 'mm' },
        'forecast' => forecast }
    end

    def self.json(bindings, url)
      response = bindings.fetch(url)
      unless response['status'] == 200
        raise Pondro::BindingError, 'Open-Meteo returned HTTP ' + response['status'].to_s
      end
      data = JSON.parse(response['body'])
      raise Pondro::BindingError, 'Invalid Open-Meteo response' unless data.is_a?(Hash) && !data['error']
      data
    end

    def self.encode(text)
      text.bytes.map do |byte|
        if (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || [45, 46, 95, 126].include?(byte)
          byte.chr
        else
          '%' + byte.to_s(16).upcase.rjust(2, '0')
        end
      end.join
    end
  end
end

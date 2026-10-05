module SecureRandom
  def self.hex(length = nil)
    random_bytes(length).unpack('H*')[0]
  end

  def self.random_bytes(length = nil)
    length = 16 if length.nil?
    raise TypeError, 'Byte length must be an Integer' unless length.is_a?(Integer)
    raise ArgumentError, 'Byte length must be non-negative' if length < 0
    bytes = ''.b
    while length > 0
      count = length > 65_536 ? 65_536 : length
      bytes << Pondro::Future.new({ 'kind' => 'binding', 'operation' => 'crypto.random_bytes',
                                   'binding' => '', 'args' => [count.to_s] }, Pondro::BindingError) do |value|
        value['bytes'].pack('C*')
      end.await
      length -= count
    end
    bytes
  end

  def self.random_number(limit = 0)
    unless limit.is_a?(Integer) || limit.is_a?(Float)
      raise ArgumentError, 'Limit must be an Integer or Float'
    end
    if limit.is_a?(Integer) && limit > 0
      # Mask before accumulation to keep every intermediate within signed int64.
      bits = limit - 1
      count = 1
      while bits > 255
        bits >>= 8
        count += 1
      end
      mask = 1
      mask = (mask << 1) | 1 while mask < bits
      loop do
        bytes = random_bytes(count).unpack('C*')
        value = bytes.shift & mask
        bytes.each { |byte| value = (value << 8) | byte }
        return value if value < limit
      end
    end
    raise ArgumentError, 'Limit must be finite' if limit.is_a?(Float) && !limit.finite?
    bytes = random_bytes(7).unpack('C*')
    value = bytes.shift & 31
    bytes.each { |byte| value = (value << 8) | byte }
    number = value / 9_007_199_254_740_992.0
    limit > 0 ? number * limit : number
  end
end

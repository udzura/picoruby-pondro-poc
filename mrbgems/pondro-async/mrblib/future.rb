module Pondro
  class RemoteError < StandardError; end

  class Future
    def initialize(request, error_class = RemoteError, &transform)
      @token = Pondro.__async_start(JSON.generate(request))
      @error_class = error_class
      @transform = transform
      @settled = false
    end

    def await
      unless @settled
        result = JSON.parse(Pondro.__async_await(@token))
        @value = result['value']
        @error = result['ok'] ? nil : @error_class.new(result['error'])
        begin
          @value = @transform.call(@value) if !@error && @transform
        rescue StandardError => error
          @error = error
        end
        @settled = true
      end
      raise @error if @error
      @value
    end

    alias read await
  end
end

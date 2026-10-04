# Invoked over SSH with configuration prepended on stdin; never pass secrets in argv.
raise "Wrong site" unless Discourse.current_hostname == "do1.musaraj.com"
username = "chat_wrapper_e2e"
email = "chat-wrapper-e2e@do1.musaraj.com"
user = User.find_by(username: username)
raise "Refusing to modify an unrelated account" if user && user.email != email
if E2E.fetch("action") == "setup"
  raise "Chat is disabled" unless SiteSetting.chat_enabled && SiteSetting.enable_public_channels
  user ||= User.create!(username: username, email: email, name: "Chat Wrapper E2E", password: E2E.fetch("password"), active: true, approved: true, trust_level: 1)
  raise "Fixture must be an active nonstaff user" unless user.active && user.approved && !user.staff?
  group = Group.find_or_create_by!(name: "chat_e2e_testers") { |g| g.full_name = "Private chat wrapper test fixtures" }
  raise "Fixture group contains unrelated users" if group.users.where.not(id: user.id).exists?
  group.add(user)
  category = Category.find_by(slug: "chat-wrapper-e2e")
  if category
    raise "Unsafe existing category" unless category.read_restricted && category.groups.pluck(:id).sort == [group.id]
  else
    category = Category.new(name: "Chat Wrapper E2E", slug: "chat-wrapper-e2e", user: Discourse.system_user, color: "0088CC", text_color: "FFFFFF")
    category.set_permissions(group.name => :full)
    category.save!
  end
  channel = category.category_channel || category.create_chat_channel!(name: "Chat Wrapper E2E", slug: "chat-wrapper-e2e", description: "Private automated desktop chat tests", user_count: 0)
  membership = channel.user_chat_channel_memberships.find_or_initialize_by(user: user)
  membership.following = true
  membership.save!
  user.user_option.update!(chat_enabled: true)
  token = UserAuthToken.generate!(user_id: user.id, user_agent: "Chat Wrapper isolated E2E", client_ip: "127.0.0.1")
  request = ActionDispatch::Request.new(Rails.application.env_config.merge(Rack::MockRequest.env_for(Discourse.base_url)))
  jar = ActionDispatch::Cookies::CookieJar.build(request, {})
  provider = Auth::DefaultCurrentUserProvider.new(request.env)
  provider.set_auth_cookie!(token.unhashed_auth_token, user, jar)
  puts "E2E_RESULT=" + JSON.generate(username: user.username, user_id: user.id, channel_id: channel.id, channel_url: "/chat/c/#{channel.slug}/#{channel.id}", cookie_name: Auth::DefaultCurrentUserProvider::TOKEN_COOKIE, browser_cookie: CGI.escape(jar[Auth::DefaultCurrentUserProvider::TOKEN_COOKIE]))
elsif E2E.fetch("action") == "verify"
  raise "Missing fixture" unless user && !user.staff?
  channel = Chat::Channel.find(E2E.fetch("channel_id"))
  raise "Wrong channel" unless channel.slug == "chat-wrapper-e2e" && channel.chatable.read_restricted
  messages = Chat::Message.where(chat_channel_id: channel.id, user_id: user.id, message: E2E.fetch("message"))
  raise "Expected exactly one message, found #{messages.count}" unless messages.count == 1
  raise "Temporary API key was not revoked" if UserApiKey.active.where(user_id: user.id).exists?
  puts "E2E_RESULT=" + JSON.generate(message_id: messages.first.id, user_id: user.id, channel_id: channel.id)
elsif E2E.fetch("action") == "cleanup"
  raise "Missing fixture" unless user && !user.staff?
  user.user_auth_tokens.destroy_all
  UserApiKey.where(user_id: user.id).destroy_all
  user.email_tokens.where(scope: EmailToken.scopes[:email_login]).destroy_all
  puts 'E2E_RESULT={"cleaned":true}'
else
  raise "Unknown action"
end

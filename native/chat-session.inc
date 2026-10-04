// App-specific backend-only operations. No cookies or tokens cross the page bridge.
static void do_chat_home(webview_t w, void *) {
  load_html_file(w, g_html_path);
}

static void do_chat_clear(webview_t w, void *arg) {
  std::string qid = *static_cast<std::string *>(arg);
  delete static_cast<std::string *>(arg);
  WKWebView *wv = (WKWebView *)webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER);
  [wv.configuration.websiteDataStore removeDataOfTypes:[WKWebsiteDataStore allWebsiteDataTypes]
    modifiedSince:[NSDate distantPast] completionHandler:^{
      sock_write_line("GOT " + qid + " {\"ok\":true}");
    }];
}

static bool chat_cookie_matches(NSHTTPCookie *cookie, NSString *host) {
  NSString *domain = cookie.domain.lowercaseString;
  NSString *bare = [domain hasPrefix:@"."] ? [domain substringFromIndex:1] : domain;
  return [host isEqualToString:bare] || ([domain hasPrefix:@"."] && [host hasSuffix:domain]);
}

@interface ChatSessionRequest : NSObject <NSURLSessionTaskDelegate>
@property(nonatomic, retain) NSURLSession *session;
@property(nonatomic, retain) WKHTTPCookieStore *store;
@property(nonatomic, copy) NSString *origin;
@property(nonatomic, copy) NSString *token;
@property(nonatomic, copy) NSString *operation;
@property(nonatomic, copy) NSString *qid;
@end

@implementation ChatSessionRequest
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
 willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *))completionHandler {
  // Never forward cookies or the OTP through redirects, even to the same origin.
  completionHandler(nil);
}
- (void)finish:(NSString *)status {
  std::string reply = "{\"status\":" + json_escape([status UTF8String]) + "}";
  sock_write_line("GOT " + std::string([self.qid UTF8String]) + " " + reply);
  [self.session finishTasksAndInvalidate];
  self.session = nil;
  [self release];
}
- (void)request:(NSString *)path method:(NSString *)method csrf:(NSString *)csrf
 completion:(void (^)(NSData *, NSHTTPURLResponse *, NSError *))completion {
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:
    [NSURL URLWithString:[self.origin stringByAppendingString:path]]];
  request.HTTPMethod = method;
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  [request setValue:@"XMLHttpRequest" forHTTPHeaderField:@"X-Requested-With"];
  if (csrf) [request setValue:csrf forHTTPHeaderField:@"X-CSRF-Token"];
  [[self.session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    completion(data, (NSHTTPURLResponse *)response, error);
  }] resume];
}
- (void)clearSiteCookies {
  [self.store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    dispatch_group_t group = dispatch_group_create();
    NSString *host = [NSURL URLWithString:self.origin].host.lowercaseString;
    for (NSHTTPCookie *cookie in cookies) {
      if (!chat_cookie_matches(cookie, host)) continue;
      dispatch_group_enter(group);
      [self.store deleteCookie:cookie completionHandler:^{ dispatch_group_leave(group); }];
    }
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{ [self finish:@"logged-out"]; });
    dispatch_release(group);
  }];
}
- (void)logout {
  [self request:@"/session/csrf.json" method:@"GET" csrf:nil completion:^(NSData *data, NSHTTPURLResponse *response, NSError *error) {
    id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    id csrf = [json isKindOfClass:[NSDictionary class]] ? [(NSDictionary *)json objectForKey:@"csrf"] : nil;
    if (error || response.statusCode != 200 || ![csrf isKindOfClass:[NSString class]] || ![csrf length]) {
      [self finish:@"unavailable"]; return;
    }
    [self request:@"/session/current.json" method:@"DELETE" csrf:csrf completion:^(NSData *body, NSHTTPURLResponse *result, NSError *failure) {
      id payload = body ? [NSJSONSerialization JSONObjectWithData:body options:0 error:nil] : nil;
      id redirect = [payload isKindOfClass:[NSDictionary class]] ? [(NSDictionary *)payload objectForKey:@"redirect_url"] : nil;
      if (failure || result.statusCode != 200 || ![redirect isKindOfClass:[NSString class]]) {
        [self finish:@"unavailable"]; return;
      }
      [self clearSiteCookies];
    }];
  }];
}
- (void)check {
  [self request:@"/session/current.json" method:@"GET" csrf:nil completion:^(NSData *data, NSHTTPURLResponse *response, NSError *error) {
    if (error) { [self finish:@"unavailable"]; return; }
    if (response.statusCode == 401 || response.statusCode == 403 || response.statusCode == 404) {
      if ([self.operation isEqualToString:@"logout"]) [self clearSiteCookies];
      else [self finish:@"expired"];
      return;
    }
    id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    id user = [json isKindOfClass:[NSDictionary class]] ? [(NSDictionary *)json objectForKey:@"current_user"] : nil;
    if (response.statusCode != 200 || ![user isKindOfClass:[NSDictionary class]] || ![[(NSDictionary *)user objectForKey:@"id"] isKindOfClass:[NSNumber class]]) {
      [self finish:@"unavailable"]; return;
    }
    if ([self.operation isEqualToString:@"logout"]) { [self logout]; return; }
    // Session rotation and login cookies must reach WebKit before chat navigates.
    dispatch_group_t group = dispatch_group_create();
    for (NSHTTPCookie *cookie in self.session.configuration.HTTPCookieStorage.cookies) {
      dispatch_group_enter(group);
      [self.store setCookie:cookie completionHandler:^{ dispatch_group_leave(group); }];
    }
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{ [self finish:@"active"]; });
    dispatch_release(group);
  }];
}
- (void)start {
  [self.store getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.timeoutIntervalForRequest = 12;
    config.timeoutIntervalForResource = 20;
    NSString *host = [NSURL URLWithString:self.origin].host.lowercaseString;
    for (NSHTTPCookie *cookie in cookies) {
      if (chat_cookie_matches(cookie, host)) {
        [config.HTTPCookieStorage setCookie:cookie];
      }
    }
    self.session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:[NSOperationQueue mainQueue]];
    if (!self.token.length) { [self check]; return; }
    [self request:@"/session/csrf.json" method:@"GET" csrf:nil completion:^(NSData *data, NSHTTPURLResponse *response, NSError *error) {
      id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      NSString *csrf = [json isKindOfClass:[NSDictionary class]] ? [(NSDictionary *)json objectForKey:@"csrf"] : nil;
      if (error || response.statusCode != 200 || ![csrf isKindOfClass:[NSString class]] || !csrf.length) {
        [self finish:@"unavailable"]; return;
      }
      NSString *path = [@"/session/otp/" stringByAppendingString:self.token];
      [self request:path method:@"POST" csrf:csrf completion:^(NSData *body, NSHTTPURLResponse *result, NSError *failure) {
        NSString *redirect = [result valueForHTTPHeaderField:@"Location"];
        NSURL *location = redirect.length ? [NSURL URLWithString:redirect relativeToURL:result.URL] : nil;
        NSURL *originURL = [NSURL URLWithString:self.origin];
        if (failure || result.statusCode != 302 || ![location.host isEqualToString:originURL.host] ||
            ![location.scheme isEqualToString:@"https"] || ![location.path isEqualToString:@"/"] ||
            !((!location.port && !originURL.port) || [location.port isEqual:originURL.port])) {
          [self finish:@"expired"]; return;
        }
        [self check];
      }];
    }];
  }];
}
- (void)dealloc {
  [_session release]; [_store release]; [_origin release]; [_token release]; [_operation release]; [_qid release];
  [super dealloc];
}
@end

struct ChatSessionArgs { std::string qid, origin, token, operation; };
static void do_chat_session(webview_t w, void *arg) {
  ChatSessionArgs *args = static_cast<ChatSessionArgs *>(arg);
  ChatSessionRequest *request = [[ChatSessionRequest alloc] init];
  request.qid = ns(args->qid);
  request.origin = ns(args->origin);
  request.token = ns(args->token);
  request.operation = ns(args->operation);
  delete args;
  NSURL *url = [NSURL URLWithString:request.origin];
  NSCharacterSet *nonHex = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF"] invertedSet];
  if (![@[@"check", @"logout"] containsObject:request.operation] ||
      ([request.operation isEqualToString:@"logout"] && request.token.length) ||
      ![url.scheme isEqualToString:@"https"] || !url.host.length || url.user || url.password || url.query || url.fragment ||
      (url.path.length && ![url.path isEqualToString:@"/"]) ||
      (request.token.length && (request.token.length != 32 || [request.token rangeOfCharacterFromSet:nonHex].location != NSNotFound))) {
    [request finish:@"unavailable"]; return;
  }
  WKWebView *wv = (WKWebView *)webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER);
  request.store = wv.configuration.websiteDataStore.httpCookieStore;
  [request start];
}
